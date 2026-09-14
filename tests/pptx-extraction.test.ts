/**
 * K17 structured ingestion: the deterministic PPTX extractor.
 * These tests use a generated in-memory OOXML deck (not committed binary), plus
 * corruption/limit guards. The REAL deck was validated in the live closure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import JSZip from 'jszip';
import { extractPptx, PPTX_LIMITS } from '../src/platform/ingestion/pptx-extraction.ts';
import { IngestionFailure } from '../src/core/ingestion/ingestion.types.ts';

async function makePptx(slides: Array<{ title?: string; body: string[] }>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  for (const [i, slide] of slides.entries()) {
    const titlePh = slide.title
      ? `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>${slide.title.split('\n').map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`
      : '';
    const bodySp = `<p:sp><p:txBody>${slide.body.map((b) => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
    const xml = `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${titlePh}${bodySp}</p:spTree></p:cSld></p:sld>`;
    zip.file(`ppt/slides/slide${i + 1}.xml`, xml);
  }
  const buf = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return buf;
}

describe('extractPptx', () => {
  it('extracts slides in order with title and body, preserving Arabic', async () => {
    const bytes = await makePptx([
      { title: 'برنامج مسائل الحيض', body: ['الحكم: الدم القوي حيض والدم الضعيف طهر', 'السطر الثاني'] },
      { body: ['لا عنوان لهذه الشريحة'] },
    ]);
    const r = await extractPptx(bytes);
    assert.equal(r.slideCount, 2);
    assert.equal(r.slides[0].number, 1);
    assert.ok(r.slides[0].text.includes('الدم القوي حيض والدم الضعيف طهر'));
    assert.ok(r.slides[0].text.includes('السطر الثاني'));
    assert.equal(r.slides[1].number, 2);
  });

  it('keeps slide order even when files are not lexically sorted', async () => {
    // slide10 then slide2: numeric ordering, not string ordering.
    const zip = new JSZip();
    const mk = (n: number, text: string) =>
      `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    zip.file('ppt/slides/slide2.xml', mk(2, 'second'));
    zip.file('ppt/slides/slide10.xml', mk(10, 'tenth'));
    const r = await extractPptx(new Uint8Array(await zip.generateAsync({ type: 'uint8array' })));
    assert.deepEqual(r.slides.map((s) => s.number), [2, 10]);
    assert.deepEqual(r.slides.map((s) => s.text), ['second', 'tenth']);
  });

  it('rejects a corrupt package', async () => {
    await assert.rejects(() => extractPptx(new Uint8Array([1, 2, 3, 4])), IngestionFailure);
  });

  it('rejects a package with no slides', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'not a deck');
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    await assert.rejects(() => extractPptx(bytes), IngestionFailure);
  });

  it('binds resource limits (entry count)', async () => {
    const zip = new JSZip();
    for (let i = 0; i < PPTX_LIMITS.maxEntries + 1; i++) zip.file(`x${i}.bin`, 'x');
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    await assert.rejects(() => extractPptx(bytes), /too many entries/);
  });
});