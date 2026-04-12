"""Homepage stats shim — proxies node-exporter and docker into one JSON endpoint.

Bound to 127.0.0.1:5055; exposed to the browser via Caddy at /api/stats.
The page is Tailscale/LAN-only so internal stats are safe to expose.
"""
import re
import socket
import subprocess
from flask import Flask, jsonify
import requests

NODE_EXPORTER_URL = "http://localhost:9100/metrics"
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 5055

app = Flask(__name__)

_METRIC_RE = re.compile(r'^([a-zA-Z_][a-zA-Z0-9_]*)(\{[^}]*\})?\s+(\S+)')
_LABEL_RE = re.compile(r'(\w+)="((?:[^"\\]|\\.)*)"')


def parse_prom(text):
    out = []
    for line in text.splitlines():
        if not line or line[0] == '#':
            continue
        m = _METRIC_RE.match(line)
        if not m:
            continue
        name, labels_str, value_str = m.groups()
        try:
            value = float(value_str)
        except ValueError:
            continue
        labels = dict(_LABEL_RE.findall(labels_str)) if labels_str else {}
        out.append((name, labels, value))
    return out


def find_one(metrics, name, labels=None):
    for n, lbls, v in metrics:
        if n != name:
            continue
        if labels and not all(lbls.get(k) == val for k, val in labels.items()):
            continue
        return v, lbls
    return None, None


def find_all(metrics, name, labels=None):
    out = []
    for n, lbls, v in metrics:
        if n != name:
            continue
        if labels and not all(lbls.get(k) == val for k, val in labels.items()):
            continue
        out.append((lbls, v))
    return out


def disk_for(metrics, mount):
    size, _ = find_one(metrics, 'node_filesystem_size_bytes', {'mountpoint': mount})
    avail, _ = find_one(metrics, 'node_filesystem_avail_bytes', {'mountpoint': mount})
    if size is None or avail is None or size == 0:
        return {'used_gb': None, 'total_gb': None, 'pct': None}
    used = size - avail
    return {
        'used_gb': round(used / 1e9, 1),
        'total_gb': round(size / 1e9, 1),
        'pct': round(used / size * 100),
    }


def docker_counts():
    try:
        result = subprocess.run(
            ['docker', 'ps', '-a', '--format', '{{.Status}}'],
            capture_output=True, text=True, timeout=5,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return {'total': None, 'running': None, 'unhealthy': None,
                'stopped': None, 'other': None}
    statuses = [s for s in result.stdout.splitlines() if s.strip()]
    running = sum(1 for s in statuses if s.startswith('Up'))
    unhealthy = sum(1 for s in statuses if 'unhealthy' in s)
    stopped = sum(1 for s in statuses if s.startswith('Exited'))
    other = len(statuses) - running - stopped
    return {
        'total': len(statuses),
        'running': running,
        'unhealthy': unhealthy,
        'stopped': stopped,
        'other': other,
    }


@app.route('/api/stats')
def stats():
    try:
        r = requests.get(NODE_EXPORTER_URL, timeout=3)
        r.raise_for_status()
    except requests.RequestException:
        return jsonify({'error': 'node-exporter unreachable'}), 503

    metrics = parse_prom(r.text)

    boot, _ = find_one(metrics, 'node_boot_time_seconds')
    now, _ = find_one(metrics, 'node_time_seconds')
    uptime = int(now - boot) if boot and now else None

    load1, _ = find_one(metrics, 'node_load1')
    load5, _ = find_one(metrics, 'node_load5')
    load15, _ = find_one(metrics, 'node_load15')

    cpu_temp, _ = find_one(
        metrics, 'node_hwmon_temp_celsius',
        {'chip': 'platform_coretemp_0', 'sensor': 'temp1'},
    )

    # RAM — use the procps `free` formula so the number matches `htop` and `free -h`:
    #   used = total - free - buffers - cached - SReclaimable + Shmem
    mem_total, _ = find_one(metrics, 'node_memory_MemTotal_bytes')
    mem_free, _ = find_one(metrics, 'node_memory_MemFree_bytes')
    mem_buffers, _ = find_one(metrics, 'node_memory_Buffers_bytes')
    mem_cached, _ = find_one(metrics, 'node_memory_Cached_bytes')
    mem_sreclaim, _ = find_one(metrics, 'node_memory_SReclaimable_bytes')
    mem_shmem, _ = find_one(metrics, 'node_memory_Shmem_bytes')
    if None not in (mem_total, mem_free, mem_buffers, mem_cached, mem_sreclaim, mem_shmem):
        ram_used_bytes = mem_total - mem_free - mem_buffers - mem_cached - mem_sreclaim + mem_shmem
        ram_used_gb = round(ram_used_bytes / 1e9, 1)
        ram_total_gb = round(mem_total / 1e9, 1)
    else:
        ram_used_gb = ram_total_gb = None

    # Drive temperatures:
    #   - NVMe via kernel hwmon (always awake, not exposed by smartmontools)
    #   - Spinning disks via smart-prom.sh textfile collector, which also exposes
    #     smart_device_active{device="..."} = 0 when the drive is parked so we
    #     can render "idle" instead of dropping the row.
    drives = []
    nvme_temp, _ = find_one(
        metrics, 'node_hwmon_temp_celsius',
        {'chip': 'nvme_nvme0', 'sensor': 'temp1'},
    )
    if nvme_temp is not None:
        drives.append({'dev': 'nvme0', 'temp_c': int(nvme_temp), 'idle': False})

    temps_by_dev = {
        lbls.get('device', '').replace('/dev/', ''): v
        for lbls, v in find_all(metrics, 'smart_device_temperature_celsius')
    }
    for lbls, v in find_all(metrics, 'smart_device_active'):
        dev = lbls.get('device', '').replace('/dev/', '')
        if not dev:
            continue
        if v == 0:
            drives.append({'dev': dev, 'temp_c': None, 'idle': True})
        else:
            t = temps_by_dev.get(dev)
            drives.append({'dev': dev, 'temp_c': int(t) if t is not None else None, 'idle': False})

    body = {
        'host': socket.gethostname(),
        'uptime_seconds': uptime,
        'load': [load1, load5, load15],
        'cpu_temp_c': int(cpu_temp) if cpu_temp is not None else None,
        'ram_used_gb': ram_used_gb,
        'ram_total_gb': ram_total_gb,
        'disk': {
            'system':  disk_for(metrics, '/'),
            'storage': disk_for(metrics, '/mnt/storage'),
            'cloud':   disk_for(metrics, '/mnt/cloud'),
        },
        'drives': drives,
        'docker': docker_counts(),
    }
    response = jsonify(body)
    response.headers['Cache-Control'] = 'no-store'
    return response


if __name__ == '__main__':
    app.run(host=LISTEN_HOST, port=LISTEN_PORT)
