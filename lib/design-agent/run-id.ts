// Names that become path parts of a design run (DEV-028 / DEV-029). Import-free,
// so the preview, the asset route and the artifact lineage share them.

export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/;
export const CANDIDATE = /^(none|default|final|candidate-[0-9]{1,2})$/;
