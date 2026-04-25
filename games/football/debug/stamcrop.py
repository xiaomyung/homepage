# Crop just the stickman area from each frame and stack them side-by-side
# for easy comparison.
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.path.join(HERE, "screenshots")
os.makedirs(OUTDIR, exist_ok=True)

frames = [Image.open(os.path.join(OUTDIR, f"stam2_{i}.png")) for i in range(6)]
# Crop to the stickman region (estimated from the 1800×560 screenshot)
crops = [f.crop((540, 120, 680, 420)) for f in frames]
w, h = crops[0].size
out = Image.new("RGB", (w * 6 + 50, h), (0, 0, 0))
for i, c in enumerate(crops):
    out.paste(c, (i * (w + 10), 0))
out.save(os.path.join(OUTDIR, "stamina_strip.png"))
print("saved")
