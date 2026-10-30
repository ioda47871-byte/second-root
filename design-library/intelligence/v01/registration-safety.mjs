/** Research-only fail-closed safety guard for the seven staged cases.
 * Never asserts original bytes, owner signatures, rights or generator approval.
 */
export function verifyCaseSafety(manifest, patterns) {
 const ok=(value,code)=>{if(!value)throw Error("RESEARCH_GUARD_"+code);};
 const r=manifest.records,c=patterns.cases,ids=["CP-026","CP-027","CP-028","CP-029","CP-030","CP-031","CP-032"];
 ok(Array.isArray(r)&&Array.isArray(c)&&r.length===c.length&&r.length>=23,"COUNTS");
 ok(manifest.registered_case_count===r.length&&patterns.registered_case_count===c.length,"DECLARED_CASE_COUNT");
 const poc=c.filter(x=>x.implementation==="local_html_css_js_poc").length;
 ok(manifest.registered_local_poc_count===poc&&patterns.registered_local_poc_count===poc,"DECLARED_POC_COUNT");
 ok(new Set(r.map(x=>x.id)).size===r.length&&new Set(c.map(x=>x.id)).size===c.length,"DUPLICATE_ID");
 ok(r.every(x=>c.some(y=>y.id===x.id))&&c.every(x=>r.some(y=>y.id===x.id)),"CASE_ID_MISMATCH");
 ok(r.every(x=>x.id!=="CP-014"&&x.id!=="CP-025"),"UNAPPROVED_CASE");
 ok(manifest.policy.not_templates===true&&manifest.policy.not_official_client_work===true&&manifest.policy.never_reuse_generated_photos_or_logos_for_other_shops===true&&manifest.policy.release_or_deployment_approval===false,"MANIFEST_POLICY");
 ok(patterns.scope==="research_only_not_auto_prompt_input"&&patterns.status==="owner_selected_case_analysis_not_approved_for_automatic_reuse"&&patterns.reuse_policy.design_principles_are_not_templates===true,"PATTERN_POLICY");
 const deny=["copy_specific_composition","copy_or_reuse_brand_logo_or_photography","copy_specific_text_or_color_recipe","claim_client_approval_or_website_launch","feed_into_production_generators_without_separate_review"];
 ok(deny.every(x=>patterns.reuse_policy.deny.includes(x)),"REUSE_DENY");
 for(const id of ids) {
  const x=r.find(z=>z.id===id),y=c.find(z=>z.id===id);
  ok(x&&y,"ADDITION_MISSING_"+id);
  ok(x.status==="owner_selected_research_design_success"&&x.design_approval_scope==="second_root_research_success_full_page_only","OWNER_SCOPE_"+id);
  ok(x.owner_decision_evidence_level===(id==="CP-026"?"positive_then_proceeded_owner_adoption_reported":"owner_explicit_selected_reported"),"OWNER_DECISION_LEVEL_"+id);
  ok(x.owner_decision_quote_primary_replay_verified===false&&x.analysis_requires_independent_review===true,"EVIDENCE_PENDING_"+id);
  ok(x.binary_original_verification==="original_unavailable"&&x.source_kind==="chat_research_analysis_metadata_original_binary_unverified","BINARY_UNVERIFIED_"+id);
  ok(typeof x.research_original_candidate_filename==="string"&&x.research_original_candidate_filename.endsWith(".zip")&&x.research_zip_sha256===undefined&&x.approved_html_sha256===undefined&&x.desktop_full_page_sha256===undefined,"BINARY_SHA_NOT_PROVEN_"+id);
  ok(x.official_client_work===false&&x.merchant_authorized===false&&x.website_deployed===false&&x.nextjs_build_verified===false&&x.image_asset_uploaded_to_github===false,"NO_COMMERCIAL_RIGHTS_"+id);
  ok(x.html_css_impl_verified==="reported_local_chromium_not_replayed"&&x.mobile_web_impl_verified==="reported_local_chromium_not_replayed","NOT_REPLAYED_"+id);
  ok(x.approved_for_generation===false&&x.approved_for_sales===false&&x.approved_for_production===false,"NO_PRODUCTION_PROMOTION_"+id);
  ok(x.web_presence_status==="HOLD_UNCONFIRMED_SOCIAL_BIO_LINK"&&x.sales_qualification==="HOLD_UNVERIFIED_WEBSITE_ABSENCE","SALES_HOLD_"+id);
  ok(y.implementation==="local_html_css_js_poc"&&x.view==="interactive_html_css_js_local_poc_full_page"&&x.approved_version,"FORM_"+id);
  ok(y.owner_selection===(id==="CP-026"?"positive_then_proceeded_research_adoption_reported":"owner_selected_research_reported"),"PATTERN_DECISION_"+id);
  ok(typeof y.evidence_ref==="string"&&/^design-library\/success-cases\/CP-\d{3}-[A-Za-z0-9-]+\.md$/.test(y.evidence_ref)&&y.evidence_ref===x.analysis_evidence_ref&&y.evidence_ref.split("/").pop().startsWith(id+"-"),"EVIDENCE_REF_"+id);
  ok(Array.isArray(y.shop_motifs)&&y.shop_motifs.length>=2&&Array.isArray(y.visual_mechanisms)&&y.visual_mechanisms.length>=1&&Array.isArray(y.known_failure_modes)&&y.known_failure_modes.length>=1&&Array.isArray(y.not_to_copy)&&y.not_to_copy.length>=1&&typeof y.structural_translation==="string"&&y.structural_translation.length>10&&typeof y.implementation_gap==="string"&&y.implementation_gap.length>10,"ANALYSIS_"+id);
 }
 return {cases:r.length,local_poc:poc,unverified_additions:ids.length};
}
