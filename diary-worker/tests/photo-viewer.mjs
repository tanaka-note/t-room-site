import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPhotoViewer } from '../public/diary-photo-viewer.js';

function fixture() {
  const images = [], replacements = [];
  class TestImage {
    src = '';
    async decode() {}
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    replaceWith(image) { replacements.push(image); }
  }
  const selection = { photos: [
    { fileName: '<img src=x>.jpg', thumbnailUrl: '/thumb/1', displayUrl: '/full/1', originalUrl: '/original/1',
      entryDate: '2026-10-01', entryTitle: '写真', originalSize: 100, width: 20, height: 30 },
    { fileName: 'second.jpg', displayUrl: '/full/2', originalUrl: '/original/2', originalSize: 200 }
  ], index: 0 };
  const nodes = { image: new TestImage(), date: {}, title: {}, status: {}, file: {}, downloadLow: {}, downloadOriginal: {} };
  const viewer = createPhotoViewer({ nodes, selection,
    formatDate: value => value || '', formatBytes: value => `${value} bytes`,
    createImage() { const image = new TestImage(); images.push(image); return image; }
  });
  return { viewer, nodes, selection, images, replacements };
}

test('render keeps thumbnail, labels, download URLs and decoded full image behavior', async () => {
  const f = fixture();
  f.viewer.render();
  assert.equal(f.nodes.image, f.images[0]);
  assert.equal(f.nodes.image.src, '/thumb/1');
  assert.equal(f.nodes.image.alt, '<img src=x>.jpg');
  assert.equal(f.nodes.title.textContent, '写真');
  assert.equal(f.nodes.file.textContent, '<img src=x>.jpg / 100 bytes / 20×30');
  assert.equal(f.nodes.downloadLow.href, '/full/1?download=1');
  assert.equal(f.nodes.downloadOriginal.href, '/original/1?download=1');
  assert.equal(f.nodes.status.textContent, '写真を読み込んでいます...');
  await f.images[1].onload();
  assert.equal(f.nodes.image, f.images[1]);
  assert.equal(f.nodes.status.hidden, true);
});

test('a late decoded image cannot overwrite a newer selection', async () => {
  const f = fixture();
  f.viewer.render();
  let finishDecode;
  f.images[1].decode = () => new Promise(resolve => { finishDecode = resolve; });
  const pending = f.images[1].onload();
  f.selection.index = 1;
  f.viewer.render();
  assert.equal(f.images[1].src, '');
  assert.equal(f.images[1].onload, null);
  assert.equal(f.nodes.image, f.images[2]);
  assert.equal(f.nodes.image.hidden, true, 'No previous thumbnail may remain for a photo without one');
  finishDecode();
  await pending;
  assert.equal(f.nodes.image, f.images[2]);
  await f.images[3].onload();
  assert.equal(f.nodes.image, f.images[3]);
});

test('closing invalidates an in-flight decode before a session or dialog reset', async () => {
  const f = fixture();
  f.viewer.render();
  let finishDecode;
  f.images[1].decode = () => new Promise(resolve => { finishDecode = resolve; });
  const pending = f.images[1].onload();
  f.viewer.cancelLoad();
  f.selection.photos = [];
  f.selection.index = -1;
  const before = f.replacements.length;
  finishDecode();
  await pending;
  f.viewer.render();
  assert.equal(f.replacements.length, before);
  assert.equal(f.images[1].src, '');
  assert.equal(f.images[1].onerror, null);
});

test('load and decode failures retain the selected thumbnail and Japanese error display', async () => {
  for (const failure of ['load', 'decode']) {
    const f = fixture();
    f.viewer.render();
    if (failure === 'load') f.images[1].onerror();
    else {
      f.images[1].decode = async () => { throw new Error('fixture decode failure'); };
      await f.images[1].onload();
    }
    assert.equal(f.nodes.image.src, '/thumb/1');
    assert.equal(f.nodes.status.textContent, '写真を読み込めませんでした。');
    assert.equal(f.nodes.status.hidden, false);
  }
});

test('callbacks from a superseded request cannot overwrite loading status or its thumbnail', () => {
  const f = fixture();
  f.viewer.render();
  const staleLoadError = f.images[1].onerror, staleThumbnailError = f.images[0].onerror;
  f.selection.index = 1;
  f.viewer.render();
  staleLoadError();
  staleThumbnailError();
  assert.equal(f.nodes.status.textContent, '写真を読み込んでいます...');
  assert.equal(f.nodes.image, f.images[2]);
});
