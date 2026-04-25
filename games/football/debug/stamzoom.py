# Zoomed-in crop of one torso at multiple fill levels.
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.path.join(HERE, "screenshots")
os.makedirs(OUTDIR, exist_ok=True)

frames = [Image.open(os.path.join(OUTDIR, f"stam2_{i}.png")) for i in range(6)]
# Zoom hard: roughly 80x220 around the upper torso
crops = [f.crop((550, 150, 670, 350)) for f in frames]
# Scale up 3× so pixels are readable
crops = [c.resize((c.width * 3, c.height * 3), Image.NEAREST) for c in crops]
w, h = crops[0].size
out = Image.new("RGB", (w * 6 + 50, h), (0, 0, 0))
for i, c in enumerate(crops):
    out.paste(c, (i * (w + 10), 0))
out.save(os.path.join(OUTDIR, "stamina_zoom.png"))
print("saved")
