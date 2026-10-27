/**
 * Design research only: fail-closed shop identity gate for generated concept images.
 * Reads structured prompt metadata plus a separately completed visual inspection.
 * Does NOT read pixels, run OCR, generate images, contact shops or approve designs.
 * Usage: node design-library/intelligence/v02/identity-audit.mjs path/to/attempt.json
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const shaOK = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/i.test(x);
const clean = (s) => typeof s === 'string'
  ? s.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, '')
  : '';
const filled = (s) => typeof s === 'string' && s.trim().length > 0;

export function auditIdentity(a) {
  const errors = [], pending = [];
  const target = a?.target || {};
  const input = a?.prompt || {};
  const output = a?.output || {};
  const check = a?.visual_inspection || {};
  const allowed = [target.official_name, ...(Array.isArray(target.allowed_aliases) ? target.allowed_aliases : [])]
    .filter(filled).map(clean);

  if (a?.schema_version !== 1 || !/^CP-\d{3}$/.test(a?.case_id || '')) {
    errors.push('SCHEMA_OR_CASE_ID_INVALID');
  }
  if (!filled(target.official_name) || !filled(target.category_code) || !filled(target.official_source_url)) {
    errors.push('TARGET_IDENTITY_INCOMPLETE');
  }
  if (allowed.length === 0) errors.push('TARGET_NAME_MISSING');
  if (!allowed.includes(clean(input.shop_name))) errors.push('PROMPT_WRONG_SHOP');
  if (input.category_code !== target.category_code) errors.push('PROMPT_WRONG_CATEGORY');
  if (input.is_research_only !== true) errors.push('NOT_MARKED_RESEARCH_ONLY');
  if (!shaOK(output.image_sha256)) pending.push('OUTPUT_IMAGE_HASH_MISSING');

  // This check is explicitly NOT automated OCR. Observations must be taken
  // while viewing the *exact* output whose SHA is being checked.
  if (check.status !== 'completed' || !['assistant_visual','human_visual'].includes(check.method)) {
    pending.push('VISUAL_INSPECTION_REQUIRED');
  } else {
    if (!shaOK(check.inspected_image_sha256) || check.inspected_image_sha256 !== output.image_sha256) {
      errors.push('INSPECTION_IMAGE_NOT_MATCHED');
    }
    if (!filled(check.reviewer_note)) pending.push('VISUAL_INSPECTION_NOTE_REQUIRED');
    if (!Array.isArray(check.visible_site_identity_labels) || check.visible_site_identity_labels.length === 0) {
      pending.push('VISIBLE_SITE_IDENTITY_UNCONFIRMED');
    } else if (check.visible_site_identity_labels.some(label => !allowed.includes(clean(label)))) {
      errors.push('VISIBLE_WRONG_OR_EXTRA_SHOP_NAME');
    }
    if (check.category_code !== target.category_code) errors.push('VISUAL_WRONG_CATEGORY');
    if (check.unreadable_site_identity === true) pending.push('BRAND_TEXT_UNREADABLE');
    if (check.image_looks_like_unrelated_shop === true) errors.push('VISUAL_UNRELATED_SHOP');
  }
  const status = errors.length ? 'REJECT' : pending.length ? 'HOLD' : 'PASS_IDENTITY_ONLY';
  return {
    case_id: a?.case_id || null, attempt_id: a?.attempt_id || null, status,
    errors, pending,
    can_show_as_target_design: status === 'PASS_IDENTITY_ONLY',
    counts_as_owner_success: false,
    note: 'PASS_IDENTITY_ONLY is not a quality score, owner approval, commercial clearance, or production gate; it relies on visual inspection of the correct image.'
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.argv[2]) { console.error('Usage: node identity-audit.mjs attempt.json'); process.exitCode = 2; }
  else {
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const result = auditIdentity(input);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'PASS_IDENTITY_ONLY') process.exitCode = 1;
  }
}
