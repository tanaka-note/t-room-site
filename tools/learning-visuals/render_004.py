from pathlib import Path
import argparse

from PIL import Image, ImageDraw, ImageFont


WIDTH, HEIGHT = 1600, 900
FONT_REGULAR = r"C:\Windows\Fonts\YuGothM.ttc"
FONT_BOLD = r"C:\Windows\Fonts\YuGothB.ttc"

NAVY = "#13365f"
GREEN = "#236149"
RED = "#b54a31"
INK = "#1d2a2f"
MUTED = "#586669"
PAPER = "#f8f7f2"
WHITE = "#ffffff"
LINE = "#c7d1cb"


def font(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REGULAR, size)


def text_size(draw, text, fnt):
    box = draw.textbbox((0, 0), text, font=fnt)
    return box[2] - box[0], box[3] - box[1]


def draw_center(draw, box, text, fnt, fill):
    x1, y1, x2, y2 = box
    w, h = text_size(draw, text, fnt)
    draw.text((x1 + (x2 - x1 - w) / 2, y1 + (y2 - y1 - h) / 2 - 3), text, font=fnt, fill=fill)


def draw_lines(draw, xy, lines, fnt, fill, spacing=8):
    x, y = xy
    for line in lines:
        draw.text((x, y), line, font=fnt, fill=fill)
        y += text_size(draw, line, fnt)[1] + spacing
    return y


def rounded(draw, box, radius=12, fill=WHITE, outline=LINE, width=2):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def fact_card(draw, box, number, title, answer_lines, note, accent):
    x1, y1, x2, y2 = box
    rounded(draw, box, 10, WHITE, "#cbd3cf", 2)
    draw.rounded_rectangle((x1, y1, x2, y1 + 8), radius=8, fill=accent)
    draw.ellipse((x1 + 18, y1 + 24, x1 + 58, y1 + 64), fill="#e7f1eb")
    draw_center(draw, (x1 + 18, y1 + 24, x1 + 58, y1 + 64), str(number), font(21, True), GREEN)
    draw.text((x1 + 72, y1 + 27), title, font=font(25, True), fill=NAVY)
    y = draw_lines(draw, (x1 + 22, y1 + 88), answer_lines, font(27, True), INK, 5)
    draw.text((x1 + 22, y + 10), note, font=font(17, True), fill=MUTED)


def build_image():
    image = Image.new("RGB", (WIDTH, HEIGHT), PAPER)
    draw = ImageDraw.Draw(image)

    for x in range(0, WIDTH, 32):
        draw.line((x, 0, x, HEIGHT), fill="#edf0eb", width=1)
    for y in range(0, HEIGHT, 32):
        draw.line((0, y, WIDTH, y), fill="#edf0eb", width=1)

    draw.text((54, 38), "T-ROOM", font=font(28, True), fill=NAVY)
    draw.text((54, 78), "Learning Log #5-004", font=font(19, True), fill=MUTED)
    draw_center(draw, (320, 22, 1280, 116), "概算保険料の追加徴収", font(53, True), NAVY)
    draw.text((1335, 34), "労働保険徴収法", font=font(20, True), fill=GREEN)
    draw.text((1367, 73), "2026-07-11", font=font(18, True), fill=MUTED)
    draw.line((54, 128, 1546, 128), fill=GREEN, width=3)

    conclusion = (54, 146, 1546, 284)
    rounded(draw, conclusion, 10, WHITE, "#b9c9bf", 2)
    draw.rounded_rectangle((54, 146, 232, 284), radius=9, fill=GREEN)
    draw.rectangle((212, 146, 232, 284), fill=GREEN)
    draw_center(draw, (54, 146, 232, 284), "まず結論", font(27, True), WHITE)
    draw.text((262, 172), "政府が保険料率を引き上げたら、政府が増加額と納期限を通知する。", font=font(28, True), fill=NAVY)
    draw.text((262, 222), "事業主が自ら追加徴収額を申告する制度ではない。", font=font(20, True), fill=MUTED)
    draw.rounded_rectangle((1254, 162, 1520, 268), radius=8, fill="#edf4ef")
    draw_lines(draw, (1274, 171), ["対象となる保険料率", "一般保険料率", "第1種・第2種・第3種", "特別加入保険料率"], font(14, True), GREEN, 3)

    gap = 14
    card_w = (1492 - gap * 3) // 4
    cards_y1, cards_y2 = 304, 526
    cards = []
    for i in range(4):
        x1 = 54 + i * (card_w + gap)
        cards.append((x1, cards_y1, x1 + card_w, cards_y2))
    fact_card(draw, cards[0], 1, "発生原因", ["政府による", "保険料率の引上げ"], "保険料算定基礎額の見込増とは別。", GREEN)
    fact_card(draw, cards[1], 2, "手続の主体", ["政府が金額と", "納期限を通知"], "事業主が計算・申告するのではない。", NAVY)
    fact_card(draw, cards[2], 3, "金額要件", ["独立した", "金額要件なし"], "200％超・差額13万円以上ではない。", GREEN)
    fact_card(draw, cards[3], 4, "納期限", ["通知を発する日から", "30日を経過した日"], "増加日から30日以内とは別。", NAVY)

    compare = (54, 546, 1546, 752)
    rounded(draw, compare, 10, WHITE, "#c3ccd0", 2)
    draw.rounded_rectangle((54, 546, 250, 752), radius=9, fill=NAVY)
    draw.rectangle((230, 546, 250, 752), fill=NAVY)
    draw_lines(draw, (82, 605), ["増加概算", "保険料との", "違い"], font(26, True), WHITE, 6)

    draw.text((282, 570), "増加概算保険料", font=font(26, True), fill=GREEN)
    draw_lines(draw, (282, 618), ["原因　保険料算定基礎額の見込額が大幅に増加", "主体　事業主が申告・納付", "判定　200％超、かつ差額13万円以上"], font(18, True), INK, 12)
    draw_center(draw, (765, 590, 865, 708), "→", font(47, True), "#a16e2c")
    draw.text((884, 570), "概算保険料の追加徴収", font=font(26, True), fill=NAVY)
    draw_lines(draw, (884, 618), ["原因　政府が保険料率を引き上げる", "主体　政府が金額と納期限を通知", "判定　独立した金額要件なし"], font(18, True), INK, 12)

    draw.rounded_rectangle((54, 772, 1546, 858), radius=9, fill=NAVY)
    draw.text((82, 797), "復習の軸", font=font(24, True), fill=WHITE)
    draw_center(draw, (260, 772, 1090, 858), "見込み増は事業主 ／ 料率引上げは政府", font(25, True), "#f5d880")
    draw.rounded_rectangle((1110, 772, 1546, 858), radius=8, fill="#eaf3ed")
    draw_lines(draw, (1130, 788), ["当初の概算保険料を延納している場合は、", "追加徴収額にも延納の論点がある。"], font(17, True), GREEN, 7)
    return image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--png", type=Path, required=True)
    parser.add_argument("--webp", type=Path, required=True)
    args = parser.parse_args()
    args.png.parent.mkdir(parents=True, exist_ok=True)
    args.webp.parent.mkdir(parents=True, exist_ok=True)
    image = build_image()
    image.save(args.png, "PNG", optimize=True)
    image.save(args.webp, "WEBP", quality=84, method=6)


if __name__ == "__main__":
    main()
