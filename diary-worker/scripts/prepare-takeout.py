"""Prepare a resumable, local Google Photos migration package. No network access."""
import argparse
import collections
import datetime as dt
import hashlib
import io
import json
import pathlib
import uuid
import zipfile
from concurrent.futures import ProcessPoolExecutor

JST = dt.timezone(dt.timedelta(hours=9))
NAMESPACE = uuid.UUID('777b28ad-2396-4327-9cf2-a0c2d8399b20')
IMAGE_TYPES = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
               '.webp': 'image/webp', '.heic': 'image/heic', '.gif': 'image/gif'}


def save_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def atomic_bytes(path, data):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_bytes(data)
    temporary.replace(path)


def metadata_timestamp(candidates):
    values = {int(m['photoTakenTime']['timestamp']) for m in candidates
              if str(m.get('photoTakenTime', {}).get('timestamp', '')).isdigit()}
    if len(values) > 1:
        raise ValueError('conflicting Google photo dates')
    return next(iter(values), None)


def exif_timestamp(image):
    exif = image.getexif()
    nested = exif.get_ifd(34665) if 34665 in exif else {}
    value = nested.get(36867) or exif.get(36867)
    if not value:
        return None
    parsed = dt.datetime.strptime(str(value), '%Y:%m:%d %H:%M:%S')
    offset = nested.get(36881) or exif.get(36881)
    zone = JST
    if offset:
        sign = -1 if str(offset).startswith('-') else 1
        hours, minutes = map(int, str(offset)[1:].split(':'))
        zone = dt.timezone(sign * dt.timedelta(hours=hours, minutes=minutes))
    return int(parsed.replace(tzinfo=zone).timestamp())


def thumbnail_bytes(image, edge, budget, quality):
    from PIL import Image
    copy = image.copy()
    copy.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    for q in range(quality, 39, -8):
        stream = io.BytesIO()
        copy.save(stream, format='WEBP', quality=q, method=3)
        data = stream.getvalue()
        if len(data) <= budget:
            return data
    return data


def initialize_worker(archives, metadata, output, year):
    global _worker_state, Image, ImageOps
    from PIL import Image, ImageOps
    import pillow_heif
    pillow_heif.register_heif_opener()
    _worker_state = (metadata, output, year, {a: zipfile.ZipFile(a) for a in archives})


def process_item(value):
    metadata, output, year, handles = _worker_state
    archive, entry = value
    path = pathlib.PurePosixPath(entry.filename)
    try:
        # ZipFile.read checks the CRC as well as returning the original bytes.
        raw = handles[archive].read(entry)
        digest = hashlib.sha256(raw).hexdigest()
        with Image.open(io.BytesIO(raw)) as image:
            timestamp = metadata_timestamp(metadata.get((str(path.parent), path.name), []))
            date_source = 'google-json'
            if timestamp is None:
                timestamp = exif_timestamp(image)
                date_source = 'exif'
            if timestamp is None:
                raise ValueError('撮影日時がありません')
            date = dt.datetime.fromtimestamp(timestamp, JST).strftime('%Y-%m-%d')
            if not date.startswith(str(year) + '-'):
                raise ValueError('指定年の範囲外')
            if not 0 < len(raw) <= 60 * 1024 * 1024:
                raise ValueError('画像の容量が60MiBを超えています')
            photo_id = str(uuid.uuid5(NAMESPACE, f'{date}:{digest}'))
            directory = output / 'photos' / photo_id
            directory.mkdir(parents=True, exist_ok=True)
            original = directory / ('original' + path.suffix.lower())
            if not original.exists():
                atomic_bytes(original, raw)
            elif hashlib.sha256(original.read_bytes()).hexdigest() != digest:
                atomic_bytes(original, raw)
            oriented = ImageOps.exif_transpose(image)
            width, height = oriented.size
            converted = oriented.convert('RGBA' if 'A' in oriented.getbands() else 'RGB')
            display = directory / 'display.webp'
            thumbnail = directory / 'thumbnail.webp'
            if not display.exists():
                atomic_bytes(display, thumbnail_bytes(converted, 1800, 320 * 1024, 88))
            if not thumbnail.exists():
                atomic_bytes(thumbnail, thumbnail_bytes(converted, 480, 100 * 1024, 82))
            variants = {key: {'path': str(file.relative_to(output)).replace('\\', '/'),
                              'bytes': file.stat().st_size,
                              'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
                        for key, file in [('original', original), ('display', display), ('thumbnail', thumbnail)]}
            return {'photo': {'id': photo_id, 'date': date, 'timestamp': timestamp,
                           'dateSource': date_source, 'fileName': path.name,
                           'mimeType': IMAGE_TYPES[path.suffix.lower()], 'width': width, 'height': height,
                           'sourceArchive': archive.name, 'sourceEntry': entry.filename, **variants}}
    except Exception as error:
        return {'excluded': {'source': entry.filename, 'reason': str(error)}}


def prepare(source, output, year):
    from PIL import Image, ImageOps
    import pillow_heif
    pillow_heif.register_heif_opener()
    output.mkdir(parents=True, exist_ok=True)
    archives = sorted(source.glob('takeout-*.zip'))
    if not archives:
        raise ValueError('No Takeout ZIP files found')
    indexed = []
    metadata = collections.defaultdict(list)
    for archive in archives:
        with zipfile.ZipFile(archive) as z:
            for entry in z.infolist():
                path = pathlib.PurePosixPath(entry.filename)
                if entry.is_dir():
                    continue
                if path.suffix.lower() == '.json' and entry.file_size <= 1_000_000:
                    m = json.loads(z.read(entry))
                    if 'title' in m and 'photoTakenTime' in m:
                        metadata[(str(path.parent), m['title'])].append(m)
                elif path.suffix.lower() in IMAGE_TYPES:
                    indexed.append((archive, entry))
        print(json.dumps({'phase': 'index', 'archive': archive.name}), flush=True)
    photos = []
    excluded = []
    duplicates = []
    seen = set()

    with ProcessPoolExecutor(max_workers=3, initializer=initialize_worker,
                         initargs=(archives, metadata, output, year)) as executor:
        for index, result in enumerate(executor.map(process_item, indexed)):
            if 'photo' in result:
                photo = result['photo']
                key = (photo['date'], photo['original']['sha256'])
                if key in seen:
                    duplicates.append({'source': photo['sourceEntry'], 'date': photo['date'], 'sha256': key[1]})
                else:
                    seen.add(key)
                    photos.append(photo)
            else:
                excluded.append(result['excluded'])
            if (index + 1) % 25 == 0 or index + 1 == len(indexed):
                save_json(output.parent / 'preparation-progress.json',
                          {'processed': index + 1, 'total': len(indexed), 'prepared': len(photos),
                           'duplicates': len(duplicates), 'excluded': excluded})
                print(json.dumps({'phase': 'prepare', 'processed': index + 1, 'total': len(indexed),
                                  'prepared': len(photos), 'duplicates': len(duplicates), 'excluded': len(excluded)}), flush=True)

    photos.sort(key=lambda p: (p['date'], p['timestamp'], p['fileName'], p['id']))
    days = []
    for date in sorted({p['date'] for p in photos}):
        selected = [p for p in photos if p['date'] == date]
        days.append({'date': date, 'title': date,
                     'requestId': str(uuid.uuid5(NAMESPACE, f'takeout:{year}:{date}')),
                     'photos': selected})
    manifest = {'version': 1, 'year': year, 'timezone': 'Asia/Tokyo', 'days': days,
                'excluded': excluded, 'duplicates': duplicates,
                'archives': [{'name': a.name, 'bytes': a.stat().st_size} for a in archives]}
    manifest['id'] = hashlib.sha256(json.dumps(days, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    manifest_path = output / 'manifest.json'
    if (output / 'migration-progress.json').exists() and manifest_path.exists():
        if json.loads(manifest_path.read_text(encoding='utf-8'))['id'] != manifest['id']:
            raise ValueError('移行開始済みのマニフェスト変更はできません')
    save_json(manifest_path, manifest)
    print(json.dumps({'phase': 'complete', 'photos': len(photos), 'days': len(days),
                      'duplicates': len(duplicates), 'excluded': excluded,
                      'originalBytes': sum(p['original']['bytes'] for p in photos)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--year', required=True, type=int)
    args = parser.parse_args()
    prepare(args.source.resolve(), args.output.resolve(), args.year)
