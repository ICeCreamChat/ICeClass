"""Prepare local painted textures for Banban's deformable rig (Pillow only)."""
from pathlib import Path
import json

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "web_controller/assets/banban"
OUT = ASSETS / "rig"


def split_eye(name, center, radius):
    eye = Image.open(ASSETS / f"eye-{name}.webp").convert("RGBA")
    # A mask separates the painted iris from its painted lash. Only the hidden
    # white socket is repaired; iris colours/highlights come from the original.
    mask = Image.new("L", (eye.width * 4, eye.height * 4))
    draw = ImageDraw.Draw(mask)
    x, y = center
    rx, ry = radius
    draw.ellipse(tuple(round(v * 4) for v in (x-rx, y-ry, x+rx, y+ry)), fill=255)
    mask = mask.resize(eye.size, Image.Resampling.LANCZOS)
    mask = ImageChops.multiply(mask, eye.getchannel("A"))
    iris = eye.copy()
    iris.putalpha(mask)
    lash = eye.copy()
    lash.putalpha(ImageChops.subtract(eye.getchannel("A"), mask))
    socket = eye.copy()
    repair = Image.new("RGBA", eye.size, (255, 254, 250, 255))
    socket.paste(repair, (0, 0), mask)
    # Keep the original silhouette; the eye can never grow a square white edge.
    socket.putalpha(eye.getchannel("A"))
    for part, image in (("iris", iris), ("socket", socket), ("lash", lash)):
        image.save(OUT / f"{part}-{name}.webp", quality=96, method=6)
    return socket, iris


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    eyes = [split_eye("left", (101, 82), (58, 59)),
            split_eye("right", (61, 82), (58, 59))]
    metadata = {}
    for mood in ("smile", "thinking", "waiting", "happy"):
        image = Image.open(ASSETS / f"eyes-{mood}.webp").convert("RGBA")
        for side, box in (("left", (175, 205, 310, 320)), ("right", (365, 205, 500, 325))):
            part = image.crop(box)
            name = f"{mood}-{side}"
            part.save(OUT / f"{name}.webp", quality=96, method=6)
            metadata[name] = list(box)
    # Forearm remains in front of the cover when the hand comes to the cheek.
    arm = Image.open(ASSETS / "arm-right.webp").convert("RGBA")
    mask = Image.new("L", arm.size)
    draw = ImageDraw.Draw(mask)
    for y in range(arm.height):
        a = round(max(0, min(1, (y / arm.height - .25) / .18)) * 255)
        draw.line((0, y, arm.width, y), fill=a)
    arm.putalpha(ImageChops.multiply(arm.getchannel("A"), mask))
    arm.save(OUT / "forearm-right.webp", quality=96, method=6)
    (OUT / "layout.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    review = Image.new("RGB", (900, 320), "#eff6fe")
    for i, (socket, iris) in enumerate(eyes):
        for j, dx in enumerate((-5, 0, 5)):
            cell = socket.copy()
            cell.alpha_composite(iris, (dx, 0))
            cell.thumbnail((135, 140))
            review.paste(cell, (i*450+j*145+10, 45), cell)
    review.save(ROOT / "output/banban/rig-eye-review.png")
    print("Prepared painted rig textures:", OUT)


if __name__ == "__main__":
    main()
