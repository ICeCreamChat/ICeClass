"""Create native classroom icons from the supplied classroom illustration (Pillow)."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


ROOT = Path(__file__).resolve().parent.parent
BRANDING = ROOT / "branding"


def main():
    source = ImageOps.exif_transpose(Image.open(BRANDING / "source.jpg")).convert("RGB")
    # This region contains the complete illustrated frame in the supplied image.
    artwork = source.crop((555, 245, 1845, 1600))

    # The dark, closed outline separates the board from the surrounding paper.
    # Fill only the exterior, then retain the connected board to discard specks.
    outline = artwork.convert("L").point(lambda value: 255 if value < 170 else 0)
    ImageDraw.floodfill(outline, (0, 0), 128)
    silhouette = outline.point(lambda value: 0 if value == 128 else 255)
    ImageDraw.floodfill(silhouette, (artwork.width // 2, artwork.height // 2), 128)
    alpha = silhouette.point(lambda value: 255 if value == 128 else 0)
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("Could not identify the illustrated board.")

    cutout = artwork.convert("RGBA")
    cutout.putalpha(alpha)
    cutout = cutout.crop(bounds)
    # Windows requires a square canvas. Its small remaining margins are clear.
    side = max(cutout.size) + 8
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(cutout, ((side - cutout.width) // 2, (side - cutout.height) // 2))

    icon = square.resize((1024, 1024), Image.Resampling.LANCZOS)
    icon.save(BRANDING / "app-icon.png")
    icon.save(BRANDING / "app.ico", sizes=[(size, size) for size in (16, 24, 32, 48, 64, 128, 256)])
    output = ROOT / "output" / "branding"
    output.mkdir(parents=True, exist_ok=True)
    preview = Image.new("RGBA", (256, 256), "#91B2C8")
    preview.alpha_composite(icon.resize((224, 224), Image.Resampling.LANCZOS), (16, 16))
    preview.convert("RGB").save(output / "rounded-icon-preview.png")
    print(f"Board bounds within source crop: {bounds}; transparent icon assets generated.")


if __name__ == "__main__":
    main()
