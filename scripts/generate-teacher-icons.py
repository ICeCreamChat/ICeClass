"""Build native teacher and website icons from the supplied artwork (Pillow)."""
import base64
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


ROOT = Path(__file__).resolve().parent.parent
BRANDING = ROOT / "branding" / "teacher"
WEB = ROOT / "web_controller"
SIZES = (16, 24, 32, 48, 64, 128, 256)


def main():
    source = ImageOps.exif_transpose(Image.open(BRANDING / "source.jpg")).convert("RGB")
    if source.size != (2400, 1792):
        raise ValueError("Expected the supplied 2400 × 1792 teacher illustration.")
    # Retain the entire original rounded frame and remove the outer paper.
    artwork = source.crop((555, 245, 1845, 1600))
    outline = artwork.convert("L").point(lambda value: 255 if value < 170 else 0)
    ImageDraw.floodfill(outline, (0, 0), 128)
    silhouette = outline.point(lambda value: 0 if value == 128 else 255)
    ImageDraw.floodfill(silhouette, (artwork.width // 2, artwork.height // 2), 128)
    alpha = silhouette.point(lambda value: 255 if value == 128 else 0)
    bounds = alpha.getbbox()
    if bounds is None or bounds[0] == 0 or bounds[1] == 0 or bounds[2] == artwork.width or bounds[3] == artwork.height:
        raise ValueError("Could not isolate the complete illustrated frame.")
    cutout = artwork.convert("RGBA")
    cutout.putalpha(alpha)
    cutout = cutout.crop(bounds)
    side = max(cutout.size) + 8
    square = Image.new("RGBA", (side, side))
    square.paste(cutout, ((side - cutout.width) // 2, (side - cutout.height) // 2))
    icon = square.resize((1024, 1024), Image.Resampling.LANCZOS)
    icon.save(BRANDING / "app-icon.png")
    icon.save(BRANDING / "app.ico", sizes=[(size, size) for size in SIZES])

    # The embedded teacher workbench and standalone website load these same files.
    assets = WEB / "assets"
    for size, name in (
        (512, "app-icon.png"), (192, "app-icon-192.png"),
        (32, "favicon.png"), (180, "apple-touch-icon.png"),
    ):
        icon.resize((size, size), Image.Resampling.LANCZOS).save(assets / name)
    (WEB / "favicon.ico").write_bytes((BRANDING / "app.ico").read_bytes())
    image_data = base64.b64encode((assets / "app-icon-192.png").read_bytes()).decode("ascii")
    (WEB / "favicon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">\n'
        f'  <image width="192" height="192" href="data:image/png;base64,{image_data}"/>\n'
        '</svg>\n', encoding="utf-8",
    )

    output = ROOT / "output" / "branding"
    output.mkdir(parents=True, exist_ok=True)
    preview = Image.new("RGB", (820, 340), "#F4F6FA")
    draw = ImageDraw.Draw(preview)
    preview.paste(icon.resize((288, 288), Image.Resampling.LANCZOS), (26, 26), icon.resize((288, 288), Image.Resampling.LANCZOS))
    draw.text((360, 28), "Windows teacher app", fill="#243349")
    for offset, size in enumerate((16, 24, 32, 48, 64)):
        image = icon.resize((size, size), Image.Resampling.LANCZOS)
        x = 362 + offset * 84
        preview.paste(image, (x, 120 - size // 2), image)
        draw.text((x, 170), str(size) + " px", fill="#64748B")
    preview.save(output / "teacher-icon-preview.png")
    print(f"Teacher frame bounds within crop: {bounds}; native and website icons generated ({len(SIZES)} ICO sizes).")


if __name__ == "__main__":
    main()
