/**
 * K17 structured ingestion: the deterministic DOCX extractor.
 * Uses a generated in-memory OOXML document (not committed binary) plus
 * corruption/limit guards. The REAL document was validated in the live closure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import JSZip from 'jszip';
import { extractDocx, DOCX_LIMITS } from '../src/platform/ingestion/docx-extraction.ts';
import { IngestionFailure } from '../src/core/ingestion/ingestion.types.ts';

async function makeDocx(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  zip.file('word/document.xml', xml);
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

describe('extractDocx', () => {
  it('extracts real Arabic paragraph text in document order', async () => {
    const bytes = await makeDocx([
      'باب الحيض والنفاس',
      'الدم القوي حيض والدم الضعيف طهر',
      'وتعتد المرأة بأقرائها',
    ]);
    const r = await extractDocx(bytes);
    assert.equal(r.paragraphCount, 3);
    assert.equal(r.text, 'باب الحيض والنفاس\nالدم القوي حيض والدم الضعيف طهر\nوتعتد المرأة بأقرائها');
    assert.ok(r.chars > 0);
  });

  it('joins multiple runs and decodes XML entities without corrupting Arabic', async () => {
    const zip = new JSZip();
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>قال </w:t></w:r><w:r><w:t>النبي</w:t></w:r><w:r><w:t> &amp; الصحابة &lt;رضي الله عنهم&gt;</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">  مسافة  </w:t></w:r></w:p>
    </w:body></w:document>`;
    zip.file('word/document.xml', xml);
    const r = await extractDocx(new Uint8Array(await zip.generateAsync({ type: 'uint8array' })));
    assert.equal(r.text, 'قال النبي & الصحابة <رضي الله عنهم>\nمسافة');
  });

  it('keeps table cell paragraphs (they are ordinary paragraphs)', async () => {
    const zip = new JSZip();
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>الحكم</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>حيض</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>`;
    zip.file('word/document.xml', xml);
    const r = await extractDocx(new Uint8Array(await zip.generateAsync({ type: 'uint8array' })));
    assert.ok(r.text.includes('الحكم'));
    assert.ok(r.text.includes('حيض'));
  });

  it('rejects a corrupt package', async () => {
    await assert.rejects(() => extractDocx(new Uint8Array([1, 2, 3, 4])), IngestionFailure);
  });

  it('rejects a package with no document body', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'not a document');
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    await assert.rejects(() => extractDocx(bytes), IngestionFailure);
  });

  it('rejects a body with no readable text (never fabricates an extraction)', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p/></w:body></w:document>');
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    await assert.rejects(() => extractDocx(bytes), /no text/);
  });

  it('binds resource limits (entry count)', async () => {
    const zip = new JSZip();
    for (let i = 0; i < DOCX_LIMITS.maxEntries + 1; i++) zip.file(`x${i}.bin`, 'x');
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    await assert.rejects(() => extractDocx(bytes), /too many entries/);
  });
});
