import test from 'node:test';
import assert from 'node:assert/strict';
import { auditIdentity } from './identity-audit.mjs';

const sha = 'a'.repeat(64);
const base = () => ({
  schema_version: 1,
  case_id: 'CP-015',
  attempt_id: 'cp015-imairo-v1',
  target: {
    official_name: 'imairo.', allowed_aliases: ['spice & cafe imairo', 'imairo'],
    category_code: 'spice_cafe_patisserie', official_source_url: 'https://www.instagram.com/imairo.spice.cafe/'
  },
  prompt: { shop_name: 'imairo.', category_code: 'spice_cafe_patisserie', is_research_only: true },
  output: { image_sha256: sha },
  visual_inspection: {
    status: 'completed', method: 'assistant_visual', inspected_image_sha256: sha,
    visible_site_identity_labels: ['imairo.'], category_code: 'spice_cafe_patisserie',
    unreadable_site_identity: false, image_looks_like_unrelated_shop: false,
    reviewer_note: 'Site header imairo.; spice, cake, coffee sections visible.'
  }
});

test('matching imairo output passes identity, but never counts as owner success', () => {
  const r = auditIdentity(base());
  assert.equal(r.status, 'PASS_IDENTITY_ONLY');
  assert.equal(r.counts_as_owner_success, false);
});

test('CP-015 cobaco bookshop swap fails name AND business category', () => {
  const a = base();
  a.visual_inspection.visible_site_identity_labels = ['cobaco'];
  a.visual_inspection.category_code = 'bookshop_zine';
  const r = auditIdentity(a);
  assert.equal(r.status, 'REJECT');
  assert.ok(r.errors.includes('VISIBLE_WRONG_OR_EXTRA_SHOP_NAME'));
  assert.ok(r.errors.includes('VISUAL_WRONG_CATEGORY'));
});

test('CP-014 KOALA bakery swap is rejected when targeting record shop', () => {
  const a = base();
  a.case_id = 'CP-014';
  a.target = {official_name:'CAN BUY RECORDS',allowed_aliases:[],category_code:'record_shop',official_source_url:'https://www.instagram.com/canbuyrecords2023/'};
  a.prompt = {shop_name:'CAN BUY RECORDS',category_code:'record_shop',is_research_only:true};
  a.visual_inspection.visible_site_identity_labels = ['KOALA'];
  a.visual_inspection.category_code = 'bakery_cafe';
  assert.equal(auditIdentity(a).status, 'REJECT');
});

test('prompt contamination blocks before a screenshot is reviewed', () => {
  const a = base();
  a.prompt.shop_name = 'cobaco';
  assert.ok(auditIdentity(a).errors.includes('PROMPT_WRONG_SHOP'));
});

test('an image without visual examination must remain on hold', () => {
  const a = base();
  a.visual_inspection = {status:'pending'};
  const r = auditIdentity(a);
  assert.equal(r.status, 'HOLD');
  assert.equal(r.can_show_as_target_design, false);
});

test('inspection of a different image hash cannot pass', () => {
  const a = base();
  a.visual_inspection.inspected_image_sha256 = 'b'.repeat(64);
  const r = auditIdentity(a);
  assert.equal(r.status, 'REJECT');
  assert.ok(r.errors.includes('INSPECTION_IMAGE_NOT_MATCHED'));
});

test('a second shop name on the page fails even when the correct name is present', () => {
  const a = base();
  a.visual_inspection.visible_site_identity_labels = ['imairo.', 'cobaco'];
  assert.equal(auditIdentity(a).status, 'REJECT');
});

test('unreadable brand cannot be silently declared a success', () => {
  const a = base();
  a.visual_inspection.unreadable_site_identity = true;
  assert.equal(auditIdentity(a).status, 'HOLD');
});

test('missing source, empty category and no research flag are blocked', () => {
  const a = base();
  delete a.target.official_source_url;
  a.prompt.is_research_only = false;
  a.target.category_code = '';
  const r = auditIdentity(a);
  assert.equal(r.status, 'REJECT');
  assert.ok(r.errors.includes('TARGET_IDENTITY_INCOMPLETE'));
  assert.ok(r.errors.includes('NOT_MARKED_RESEARCH_ONLY'));
});
