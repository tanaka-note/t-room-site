from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


WIDTH, HEIGHT = 1600, 900
FONT_REGULAR = r"C:\Windows\Fonts\YuGothM.ttc"
FONT_BOLD = r"C:\Windows\Fonts\YuGothB.ttc"

NAVY = "#12365f"
BLUE = "#315f9d"
GREEN = "#236149"
TEAL = "#177f7c"
AMBER = "#a66b20"
RED = "#a84a3b"
INK = "#1d2a2f"
MUTED = "#5e6a6d"
PAPER = "#f7f7f3"
WHITE = "#ffffff"
LINE = "#cad4d0"


ARTICLES = {
    "001": {
        "date": "2026-07-08",
        "title": "継続事業の概算保険料の延納",
        "conclusion": ["延納の対象は概算保険料。確定保険料は延納できない。", "金額要件または事務組合委託を確認し、成立時期にも注意する。"],
        "cards": [
            ("対象", "概算保険料", "確定保険料は延納不可"),
            ("金額要件", "40万円以上", "片方のみなら20万円以上"),
            ("例外", "事務組合委託", "金額にかかわらず延納可能"),
            ("成立時期", "10月1日以降", "成立した事業は延納不可"),
        ],
        "left_title": "納期限の軸",
        "left_lines": ["第1期　7月10日", "第2期　10月31日 → 11月14日", "第3期　翌年1月31日 → 翌年2月14日"],
        "right_title": "覚える順番",
        "right_lines": ["1　確定ではなく概算か", "2　金額要件または事務組合委託", "3　10月1日以降成立ではないか"],
        "memory": "事務組合委託の14日延長は第2期・第3期。端数は第1期へ。",
    },
    "002": {
        "date": "2026-07-08",
        "title": "有期事業の概算保険料の延納",
        "conclusion": ["有期事業では、まず全期間が6か月を超えるかを確認する。", "そのうえで75万円以上、または事務組合委託かを判定する。"],
        "cards": [
            ("期間要件", "6か月超", "全期間6か月以内は延納不可"),
            ("金額要件", "75万円以上", "継続事業の基準と混同しない"),
            ("例外", "事務組合委託", "金額要件にかかわらない"),
            ("申請時期", "申告書提出時", "提出時に延納を申請"),
        ],
        "left_title": "延納できるか",
        "left_lines": ["全期間が6か月超", "かつ", "75万円以上 または 事務組合委託"],
        "right_title": "納期限の見方",
        "right_lines": ["最初の期は成立時点で区切る", "2期目以降は期ごとの納期限", "継続事業の40万円基準は使わない"],
        "memory": "有期は「6か月超」「75万円以上または事務組合委託」「申告時申請」。",
    },
    "003": {
        "date": "2026-07-10",
        "title": "増加概算保険料",
        "conclusion": ["労働者や賃金が少し増えただけで、必ず申告する制度ではない。", "200％超と差額13万円以上の両方を満たすかを確認する。"],
        "cards": [
            ("割合要件", "200％を超える", "増加前の見込額と比較"),
            ("差額要件", "13万円以上", "2つの要件を両方満たす"),
            ("申告期限", "増加日から30日", "具体計算は翌日を1日目"),
            ("減少時", "確定時に精算", "30日以内の還付制度ではない"),
        ],
        "left_title": "発生する2つの場面",
        "left_lines": ["保険料算定基礎額の見込額が増加", "片保険から両保険になり", "一般保険料率が変わる"],
        "right_title": "延納の軸",
        "right_lines": ["当初の概算保険料を延納中", "申告書提出時に延納を申請", "残りの期数で各期分を分ける"],
        "memory": "増加概算は「200％超」かつ「差額13万円以上」、期限は30日。",
    },
    "005": {
        "date": "2026-07-13",
        "title": "概算保険料の認定決定",
        "conclusion": ["申告書が未提出、または記載に誤りがあると政府が額を決定する。", "不足額は通知を受けた日の翌日から15日以内に納付する。"],
        "cards": [
            ("対象1", "申告書が未提出", "未申告だけで終わらない"),
            ("対象2", "記載に誤り", "政府が額を決定・通知"),
            ("納付期限", "翌日から15日", "通知を受けた日の翌日起算"),
            ("追徴金", "課されない", "確定保険料との違い"),
        ],
        "left_title": "3種類の違い",
        "left_lines": ["概算　認定決定あり・追徴金なし", "確定　認定決定あり・原則追徴金あり", "増加概算　認定決定の規定なし"],
        "right_title": "延納との関係",
        "right_lines": ["一般の延納要件を満たせば延納可能", "認定決定後の納付時に申請", "最初に納める期分は15日以内"],
        "memory": "概算は認定決定あり、追徴金なし。通知翌日から15日。",
    },
    "006": {
        "date": "2026-07-15",
        "title": "継続事業の確定保険料",
        "conclusion": ["前年度の実績賃金で確定保険料を計算し、概算保険料との差額を精算する。", "新年度の概算保険料とあわせて行う手続が年度更新。"],
        "cards": [
            ("保険年度", "4月1日～3月31日", "前年度の実績を確定"),
            ("年度更新", "6月1日～7月10日", "確定と新年度概算を申告"),
            ("基本式", "実績賃金×料率", "対象が異なる場合は区分算定"),
            ("廃止時", "消滅日から50日", "通常の年度更新と区別"),
        ],
        "left_title": "差額が出たら",
        "left_lines": ["確定 ＞ 概算　不足額を納付", "確定 ＝ 概算　追加納付なし・申告必要", "確定 ＜ 概算　充当または還付"],
        "right_title": "一括有期事業",
        "right_lines": ["継続事業と同様に年度更新", "年度中に終了した工事等が対象", "建設事業は報告書と総括表を提出"],
        "memory": "確定保険料は前年度の実績。納付額がなくても申告は必要。",
    },
    "007": {
        "date": "2026-07-16",
        "title": "有期事業の確定保険料",
        "conclusion": ["単独有期事業は、開始時に概算、終了後に確定して差額を精算する。", "毎年の年度更新ではなく、一つの事業ごとに手続する。"],
        "cards": [
            ("成立届", "成立日から10日", "日数計算は原則初日不算入"),
            ("概算保険料", "成立日から20日", "全期間の見込賃金で計算"),
            ("保険関係消滅", "終了・廃止の翌日", "消滅日を基準にする"),
            ("確定保険料", "消滅日から50日", "実際の賃金で差額精算"),
        ],
        "left_title": "建設事業の特例",
        "left_lines": ["実際の賃金把握が困難な場合", "調整後の請負金額 × 労務費率", "これに労災保険率を乗じる"],
        "right_title": "単独と一括",
        "right_lines": ["単独　事業ごとに20日・50日", "一括　年度更新でまとめて申告", "建設事業は報告書と総括表"],
        "memory": "単独有期は、成立届10日・概算20日・確定50日。",
    },
    "008": {
        "date": "2026-07-16",
        "title": "確定保険料の申告先・納付先",
        "conclusion": ["法令上の提出先は、所轄都道府県労働局歳入徴収官。", "申告書の種類や納付額に応じ、監督署や金融機関などを経由できる。"],
        "cards": [
            ("労働局・監督署", "申告書を提出", "添付書類も受け付ける"),
            ("金融機関", "納付と同時のみ", "添付書類は提出できない"),
            ("徴収事務センター", "申告書のみ", "添付書類・納付は不可"),
            ("電子申請", "e-Gov", "要件を満たせば電子納付"),
        ],
        "left_title": "金融機関へ出せない場合",
        "left_lines": ["口座振替を利用している", "納付する金額がない", "申告書に添付書類がある"],
        "right_title": "延納できない金額",
        "right_lines": ["確定保険料の不足額", "一般拠出金", "金額にかかわらず第1期に納付"],
        "memory": "金融機関は納付とセット。確定不足額と一般拠出金は延納なし。",
    },
    "009": {
        "date": "2026-07-18",
        "title": "確定保険料の還付・充当",
        "conclusion": ["概算保険料が確定保険料を超えると、その超過額を還付または充当する。", "還付請求がなければ、次年度保険料や未納額などへ充当される。"],
        "cards": [
            ("還付請求あり", "超過額を還付", "還付請求書を提出"),
            ("還付請求なし", "超過額を充当", "次年度概算・未納額など"),
            ("一般拠出金", "充当できる", "労働保険料とは別の拠出金"),
            ("時効", "2年", "還付を受ける権利"),
        ],
        "left_title": "誰が処理するか",
        "left_lines": ["還付　官署支出官または資金前渡官吏", "充当　所轄労働局歳入徴収官", "充当したときは事業主へ通知"],
        "right_title": "残額が出たら",
        "right_lines": ["選択した充当先へ順に充当", "すべて充当しても残額がある", "残額の還付には還付請求書が必要"],
        "memory": "還付は請求あり、充当は請求なし。一般拠出金にも充当できる。",
    },
    "010": {
        "date": "2026-07-19",
        "title": "確定保険料の認定決定",
        "conclusion": ["申告書が未提出、または記載に誤りがあると政府が額を決定・通知する。", "納付すべき確定保険料または不足額には、原則10％の追徴金がある。"],
        "cards": [
            ("認定決定の対象", "未提出・記載誤り", "政府が決定して通知"),
            ("不足額の期限", "通知から15日", "具体計算は翌日起算"),
            ("追徴金", "原則10％", "1,000円未満を切り捨て"),
            ("追徴金の期限", "発してから30日", "受けた日との違いに注意"),
        ],
        "left_title": "追徴金がない場合",
        "left_lines": ["納付すべき額が1,000円未満", "天災その他やむを得ない理由", "概算保険料の認定決定"],
        "right_title": "試験の軸",
        "right_lines": ["認定決定・追徴金は納入告知書", "確定保険料は延納できない", "概算保険料と合算して判定しない"],
        "memory": "決められたら15日、追徴金は原則10％、その期限は発して30日。",
    },
    "011": {
        "date": "2026-07-19",
        "title": "労働保険料の口座振替納付",
        "conclusion": ["口座振替の中心は、年度更新と概算保険料の延納各期。", "最初の納付や臨時・認定決定による納付は対象外。"],
        "cards": [
            ("年度更新", "対象", "概算・確定不足額など"),
            ("延納各期", "対象", "第2期・第3期など"),
            ("単独有期", "対象となる場合", "対象となる概算保険料"),
            ("一般拠出金", "年度更新分は対象", "徴収法の仕組みを準用"),
        ],
        "left_title": "対象外の代表例",
        "left_lines": ["増加概算保険料・追加徴収", "概算・確定保険料の認定決定額", "追徴金・延滞金・印紙保険料"],
        "right_title": "手続の注意",
        "right_lines": ["依頼書は希望する金融機関へ提出", "金融機関へ年度更新申告書は出せない", "口座振替でも申告期限は延びない"],
        "memory": "年度更新と延納各期が中心。増加・追加・認定決定は対象外。",
    },
}


def get_font(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REGULAR, size)


def text_width(draw, text, font):
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0]


def wrap_text(draw, text, font, max_width):
    lines = []
    current = ""
    for char in text:
        candidate = current + char
        if current and text_width(draw, candidate, font) > max_width:
            lines.append(current)
            current = char
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def draw_center(draw, box, text, font, fill):
    x1, y1, x2, y2 = box
    bounds = draw.textbbox((0, 0), text, font=font)
    width = bounds[2] - bounds[0]
    height = bounds[3] - bounds[1]
    draw.text((x1 + (x2 - x1 - width) / 2, y1 + (y2 - y1 - height) / 2 - 4), text, font=font, fill=fill)


def rounded(draw, box, fill=WHITE, outline=LINE, radius=14, width=2):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_wrapped(draw, x, y, text, font, fill, max_width, spacing=7):
    for line in wrap_text(draw, text, font, max_width):
        draw.text((x, y), line, font=font, fill=fill)
        bounds = draw.textbbox((0, 0), line, font=font)
        y += bounds[3] - bounds[1] + spacing
    return y


def draw_article(article_id, spec):
    image = Image.new("RGB", (WIDTH, HEIGHT), PAPER)
    draw = ImageDraw.Draw(image)

    for x in range(0, WIDTH, 40):
        draw.line((x, 0, x, HEIGHT), fill="#ecefea", width=1)
    for y in range(0, HEIGHT, 40):
        draw.line((0, y, WIDTH, y), fill="#ecefea", width=1)

    draw.text((54, 32), "T-ROOM", font=get_font(30, True), fill=NAVY)
    draw.text((54, 74), f"Learning Log #5-{article_id}", font=get_font(19, True), fill=MUTED)
    draw_center(draw, (300, 16, 1295, 116), spec["title"], get_font(50, True), NAVY)
    draw.text((1340, 38), "労働保険徴収法", font=get_font(19, True), fill=GREEN)
    draw.text((1385, 76), spec["date"], font=get_font(17, True), fill=MUTED)
    draw.line((54, 128, 1546, 128), fill=GREEN, width=3)

    rounded(draw, (54, 146, 1546, 278), fill=WHITE, outline="#b8c9bf")
    draw.rounded_rectangle((54, 146, 238, 278), radius=12, fill=GREEN)
    draw.rectangle((218, 146, 238, 278), fill=GREEN)
    draw_center(draw, (54, 146, 238, 278), "まず結論", get_font(27, True), WHITE)
    draw_wrapped(draw, 270, 166, spec["conclusion"][0], get_font(26, True), NAVY, 1235)
    draw_wrapped(draw, 270, 218, spec["conclusion"][1], get_font(19, True), MUTED, 1235)

    gap = 14
    card_width = (1492 - gap * 3) // 4
    for index, (label, value, note) in enumerate(spec["cards"]):
        x1 = 54 + index * (card_width + gap)
        x2 = x1 + card_width
        rounded(draw, (x1, 300, x2, 506), fill=WHITE, outline="#c8d1cd")
        draw.rounded_rectangle((x1, 300, x2, 308), radius=8, fill=TEAL if index % 2 else BLUE)
        draw.ellipse((x1 + 18, 324, x1 + 58, 364), fill="#e8f2ef")
        draw_center(draw, (x1 + 18, 324, x1 + 58, 364), str(index + 1), get_font(21, True), GREEN)
        draw_wrapped(draw, x1 + 72, 327, label, get_font(23, True), NAVY, card_width - 92, 4)
        draw_wrapped(draw, x1 + 22, 391, value, get_font(27, True), INK, card_width - 44, 4)
        draw_wrapped(draw, x1 + 22, 452, note, get_font(16, True), MUTED, card_width - 44, 3)

    left = (54, 530, 790, 746)
    right = (810, 530, 1546, 746)
    for box, title, lines, accent in ((left, spec["left_title"], spec["left_lines"], NAVY), (right, spec["right_title"], spec["right_lines"], GREEN)):
        x1, y1, x2, y2 = box
        rounded(draw, box, fill=WHITE, outline="#c4cfca")
        draw.rounded_rectangle((x1, y1, x2, y1 + 58), radius=12, fill=accent)
        draw.rectangle((x1, y1 + 42, x2, y1 + 58), fill=accent)
        draw.text((x1 + 26, y1 + 13), title, font=get_font(25, True), fill=WHITE)
        y = y1 + 82
        for i, line in enumerate(lines, 1):
            draw.ellipse((x1 + 26, y + 2, x1 + 54, y + 30), fill="#e8f1ed")
            draw_center(draw, (x1 + 26, y + 2, x1 + 54, y + 30), str(i), get_font(16, True), GREEN)
            draw_wrapped(draw, x1 + 70, y, line, get_font(20, True), INK, x2 - x1 - 96, 3)
            y += 48

    draw.rounded_rectangle((54, 770, 1546, 856), radius=12, fill=NAVY)
    draw.text((82, 793), "復習用の一言", font=get_font(23, True), fill=WHITE)
    draw_wrapped(draw, 292, 793, spec["memory"], get_font(25, True), "#f5d786", 1215, 3)
    return image


def main():
    root = Path(__file__).resolve().parents[2]
    output_dir = root / "images" / "learning" / "sharoushi"
    preview_dir = root / "tools" / "learning-visuals" / "previews"
    output_dir.mkdir(parents=True, exist_ok=True)
    preview_dir.mkdir(parents=True, exist_ok=True)

    for article_id, spec in ARTICLES.items():
        image = draw_article(article_id, spec)
        stem = f"learning-{article_id}-code"
        image.save(preview_dir / f"{stem}.png", "PNG", optimize=True)
        image.save(output_dir / f"{stem}.webp", "WEBP", quality=84, method=6)


if __name__ == "__main__":
    main()
