import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { resolveDirection } from "@/lib/design-agent/phase2f/open-direction";
import { buildDesignPrompt, DesignBrief, type PromptVariant } from "@/lib/design-agent/phase2f/prompt";
import { ResearchSection } from "@/lib/design-agent/phase2f/research-section";
import { ThreeMethodBrief } from "@/lib/design-agent/three-methods/brief";

// DEV-139 (activation of v2.1): every prompt version that existed before it is unchanged, byte for byte. The SHA-256
// and character count of each combination below were captured from develop 5af70616 (before v2.1 was activated) with
// the same builder calls: versions v1, v1.1, v1.1 + research, v2 and v3 (wagashi-open-a / -b) and tm0, routes B and C,
// on every committed facts fixture (the 9 shop_facts_pack_v1 files under design-library). "refused" rows are combinations the builder refuses (v1.1 on route C, tm0 with
// another shop's facts), with the code they were refused with. Offline: nothing is called.

const REPO = resolve(__dirname, "../../../..");
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8")) as unknown;
const PACKS: Record<string, string> = {
  "phase2f/wagashi-facts-pack.json": "design-library/phase2f/wagashi-facts-pack.json",
  "three-methods/facts-pack.json": "design-library/research/three-methods/facts-pack.json",
  "bakery/facts-pack.json": "design-library/research/quality-pipeline/poc/bakery/facts-pack.json",
  "cafe/facts-pack.json": "design-library/research/quality-pipeline/poc/cafe/facts-pack.json",
  "wagashi/facts-pack.json": "design-library/research/quality-pipeline/poc/wagashi/facts-pack.json",
  "bicycle/facts-pack.json": "design-library/research/quality-pipeline/poc/bicycle/facts-pack.json",
  "sendable-tamaki/facts-pack.json": "design-library/research/quality-pipeline/poc/sendable-tamaki/facts-pack.json",
  "sento/facts-pack.json": "design-library/research/quality-pipeline/poc/sento/facts-pack.json",
  "tsugute/facts-pack.json": "design-library/research/quality-pipeline/poc/tsugute/facts-pack.json",
};
const brief = DesignBrief.parse(read("design-library/phase2f/wagashi-brief-v4.json"));
const research = ResearchSection.parse(read("design-library/phase2f/research/wagashi-b-research-v1.json"));
const refs = read("design-library/phase2f/references/success-references-v1.json");
const open = (version: "v2" | "v3", id: string): PromptVariant => {
  const r = resolveDirection(read(`design-library/phase2f/directions/${id}.json`), refs);
  if (!r.ok) throw new Error(r.code);
  return { version, direction: r.direction, references: r.references };
};
const VARIANTS: Record<string, { variant: PromptVariant; brief: boolean }> = {
  v1: { variant: { version: "v1" }, brief: true },
  "v1.1": { variant: { version: "v1.1", research: null }, brief: true },
  "v1.1+research": { variant: { version: "v1.1", research }, brief: true },
  "v2/wagashi-open-a": { variant: open("v2", "wagashi-open-a"), brief: false },
  "v2/wagashi-open-b": { variant: open("v2", "wagashi-open-b"), brief: false },
  "v3/wagashi-open-a": { variant: open("v3", "wagashi-open-a"), brief: false },
  "v3/wagashi-open-b": { variant: open("v3", "wagashi-open-b"), brief: false },
  tm0: { variant: { version: "tm0", brief: ThreeMethodBrief.parse(read("design-library/research/three-methods/brief.json")) }, brief: false },
};

/** [facts, route, version, SHA-256 | "refused", chars | refusal code] — captured from develop 5af70616. */
const PINNED: [string, "B_html_prototype" | "C_hybrid", string, string, number | string][] = [
  ["phase2f/wagashi-facts-pack.json", "B_html_prototype", "v1", "a2fdd00365087046c44f03b4c3ea43530046af658b017ae5229fd7577c817954", 5706],
  ["phase2f/wagashi-facts-pack.json", "B_html_prototype", "v1.1", "c5973afbdc87b750cb12f05438c6a2b328407b3d226ad0c89fe44107bbada243", 6010],
  ["phase2f/wagashi-facts-pack.json", "B_html_prototype", "v1.1+research", "a0dbb48c1b85629e1ddedaed2a6015e781adb3696c01b824f360ae74c5c1a0c2", 7741],
  ["phase2f/wagashi-facts-pack.json", "B_html_prototype", "v2/wagashi-open-a", "0ad56d85df1c713047d638664fa4872f710003c841f2f96db0fd5f397fc46070", 6996],
  ["phase2f/wagashi-facts-pack.json", "B_html_prototype", "v2/wagashi-open-b", "20a2b19cba16486bcbc6695d5b207a2a805bbb438709ad46e9685c3257e31a23", 6878],
  ["phase2f/wagashi-facts-pack.json", "B_html_prototype", "v3/wagashi-open-a", "3ca3f33da64c669a90bc8a9e912c4199136d8433e3031c9482d25a20c7b0f487", 9594],
  ["phase2f/wagashi-facts-pack.json", "B_html_prototype", "v3/wagashi-open-b", "a90d99c0b2a69ebb367e9d0ad8db06944115407aa81f2045689f874c074ee4a4", 9476],
  ["phase2f/wagashi-facts-pack.json", "B_html_prototype", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["phase2f/wagashi-facts-pack.json", "C_hybrid", "v1", "20b6ec350c583c072f6c3bd466e8ce9ccf988d22645520742834137e64aa8845", 6200],
  ["phase2f/wagashi-facts-pack.json", "C_hybrid", "v1.1", "refused", "PROMPT_VARIANT_ROUTE"],
  ["phase2f/wagashi-facts-pack.json", "C_hybrid", "v1.1+research", "refused", "PROMPT_VARIANT_ROUTE"],
  ["phase2f/wagashi-facts-pack.json", "C_hybrid", "v2/wagashi-open-a", "9318345da131ef3bfab6531b0a06b1b702c8dbb11a61ef9e1fb2114a7fcdeb9d", 7442],
  ["phase2f/wagashi-facts-pack.json", "C_hybrid", "v2/wagashi-open-b", "0b64529c445c824d03a0d0f719a4038c4fb0facc48a0cf99dbb2881e2c27e647", 7324],
  ["phase2f/wagashi-facts-pack.json", "C_hybrid", "v3/wagashi-open-a", "09de0749fabee3ae9705e37cb2aeecf242e28b8a67c3ff0f08a31153c7880fff", 10040],
  ["phase2f/wagashi-facts-pack.json", "C_hybrid", "v3/wagashi-open-b", "faf40d24a92dce62d47dc4911c0044b015cbeef5e3fa5d60a76fc31786fc39f2", 9922],
  ["phase2f/wagashi-facts-pack.json", "C_hybrid", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["three-methods/facts-pack.json", "B_html_prototype", "v1", "3207346637c3eaa86540fda75ceb0d6a53eb278f3b1f3c6355102051d1052150", 5715],
  ["three-methods/facts-pack.json", "B_html_prototype", "v1.1", "691a64ab1bdf8b6584276c712988caa43e5a10b8d5f214d75c4819738b6fe95e", 6019],
  ["three-methods/facts-pack.json", "B_html_prototype", "v1.1+research", "5f399e1b4c354a80ff292155337cb27dd768cabf6ea8f0298b61024e192c3937", 7750],
  ["three-methods/facts-pack.json", "B_html_prototype", "v2/wagashi-open-a", "09b941e7f7e5a34b5d02ba49a110d5a6a55b13605b4e189cdeac563ef990106d", 7005],
  ["three-methods/facts-pack.json", "B_html_prototype", "v2/wagashi-open-b", "6ba64c6d88015f8d7b497bacc4304b270e24acc6796acd51262ef7697aac6626", 6887],
  ["three-methods/facts-pack.json", "B_html_prototype", "v3/wagashi-open-a", "6260c7d4c80f06d8fd75b1eedf2e3d6f63323f7af9339176322376bc4b25065c", 9603],
  ["three-methods/facts-pack.json", "B_html_prototype", "v3/wagashi-open-b", "be5598ee8cb9c880bbbad9d531db176ab6bad2e920518b789500136caf386d9c", 9485],
  ["three-methods/facts-pack.json", "B_html_prototype", "tm0", "d8cc6c6984088245d68b00d694dc05bd4b67364de326421ad6d707750316812a", 3846],
  ["three-methods/facts-pack.json", "C_hybrid", "v1", "0fd93a09191cd532f9db980dfbb756a41a3359a52197bf8d6695b55a8626ceeb", 6209],
  ["three-methods/facts-pack.json", "C_hybrid", "v1.1", "refused", "PROMPT_VARIANT_ROUTE"],
  ["three-methods/facts-pack.json", "C_hybrid", "v1.1+research", "refused", "PROMPT_VARIANT_ROUTE"],
  ["three-methods/facts-pack.json", "C_hybrid", "v2/wagashi-open-a", "e154586a75616b4e23e067013022ec5fd4ce4dd81a5fbe7c774bdfdb185c7ddd", 7451],
  ["three-methods/facts-pack.json", "C_hybrid", "v2/wagashi-open-b", "d3a7607467752183b85cc7528a4e399e221fb045a867be2a69915639c6258019", 7333],
  ["three-methods/facts-pack.json", "C_hybrid", "v3/wagashi-open-a", "3ea83a7fb5d7705e747ded40cd04aa4eb5f762cd35461cd16cb341d1c9708954", 10049],
  ["three-methods/facts-pack.json", "C_hybrid", "v3/wagashi-open-b", "96686d6e653d6c042fa3bacd393cb4e11593d68707eed5216dd770e558ee9b4f", 9931],
  ["three-methods/facts-pack.json", "C_hybrid", "tm0", "f6632d283bbb1ed59941cd2064dd286b31968799d0f91c3c7b179967dbc0e0ac", 4415],
  ["bakery/facts-pack.json", "B_html_prototype", "v1", "c3acc21ace8a58ca24400c8c851fd56f31a46d64a00c6e38ed1c327aae0a2a24", 5762],
  ["bakery/facts-pack.json", "B_html_prototype", "v1.1", "d1f3206485142d306c4790fd0526b8a36fd0a5b2d1009278f22562eb0d42a5db", 6066],
  ["bakery/facts-pack.json", "B_html_prototype", "v1.1+research", "71bae8b39dd02ba448c52fb2f3b2939cc983ff3118de6c4e8b6f514a247170f4", 7797],
  ["bakery/facts-pack.json", "B_html_prototype", "v2/wagashi-open-a", "839369f2c8bae759c86bc855b73806e22b61e6d657c9f93c9279f13b3767c467", 7052],
  ["bakery/facts-pack.json", "B_html_prototype", "v2/wagashi-open-b", "76d3e5241bda3788eecad42ef6aeccd7a1b02a56402c6e48310eeb58bd1e0888", 6934],
  ["bakery/facts-pack.json", "B_html_prototype", "v3/wagashi-open-a", "7901dec5d1bd160a2acd1ee79dda91e42332827b6b32eaac5be1f3e1f49f2e52", 9650],
  ["bakery/facts-pack.json", "B_html_prototype", "v3/wagashi-open-b", "175bce057aca6d6327449f6dd96e1317c078474667847535056bc7d73962ef37", 9532],
  ["bakery/facts-pack.json", "B_html_prototype", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["bakery/facts-pack.json", "C_hybrid", "v1", "ab7bd42678e04c80730a2a73eb71c7ca57f123ee6dcc8ae04e98157612054bd3", 6256],
  ["bakery/facts-pack.json", "C_hybrid", "v1.1", "refused", "PROMPT_VARIANT_ROUTE"],
  ["bakery/facts-pack.json", "C_hybrid", "v1.1+research", "refused", "PROMPT_VARIANT_ROUTE"],
  ["bakery/facts-pack.json", "C_hybrid", "v2/wagashi-open-a", "96efa3e7c5733b1f80c83b21c8072c501d7f8e70033f302d18134b7aedbe4045", 7498],
  ["bakery/facts-pack.json", "C_hybrid", "v2/wagashi-open-b", "a3a1ced301278503036221572465cf5fe0d23c8bad7918740d5fb3537076ef70", 7380],
  ["bakery/facts-pack.json", "C_hybrid", "v3/wagashi-open-a", "cb7b620549d5139c0f4b59d5c09f4306259b717e3177a7d6246cea64f93435a0", 10096],
  ["bakery/facts-pack.json", "C_hybrid", "v3/wagashi-open-b", "ab1d0760cf3b1d0e79ccf88a74080806a50eaa42f3b9d8ab1c44828757e5dd0f", 9978],
  ["bakery/facts-pack.json", "C_hybrid", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["cafe/facts-pack.json", "B_html_prototype", "v1", "a6003f6393afadf595d6508e98f04c202904f821e787976bf5397428f4648771", 5740],
  ["cafe/facts-pack.json", "B_html_prototype", "v1.1", "1239d913ea4b283f55e3216b48032d27022e4d6b6c1af78c4dd7bef531424384", 6044],
  ["cafe/facts-pack.json", "B_html_prototype", "v1.1+research", "3519f5ad793b93446061c93c5b4443735538150a544a0a687b12c0398125418f", 7775],
  ["cafe/facts-pack.json", "B_html_prototype", "v2/wagashi-open-a", "e8e296817b803bb4ee750850aa7f5649ee58b52fec0cb20213d83c446e4babbb", 7030],
  ["cafe/facts-pack.json", "B_html_prototype", "v2/wagashi-open-b", "bcf3482f74ba5321df81eea1084fd5894946c00b606eabd25346b52defe9cda6", 6912],
  ["cafe/facts-pack.json", "B_html_prototype", "v3/wagashi-open-a", "7376696e3b24fd04a6b0c63e004caa0bd0fa2ff270fcb7b493797ac2c9defd48", 9628],
  ["cafe/facts-pack.json", "B_html_prototype", "v3/wagashi-open-b", "7dbe0b6e5fce86908bb118de00b7f27c50ff04ff467aecc5fd48a190e1053dce", 9510],
  ["cafe/facts-pack.json", "B_html_prototype", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["cafe/facts-pack.json", "C_hybrid", "v1", "315cfc0b59a8a0b6f08ae413ca65941681003d7f1bf170c59923b4efa049776d", 6234],
  ["cafe/facts-pack.json", "C_hybrid", "v1.1", "refused", "PROMPT_VARIANT_ROUTE"],
  ["cafe/facts-pack.json", "C_hybrid", "v1.1+research", "refused", "PROMPT_VARIANT_ROUTE"],
  ["cafe/facts-pack.json", "C_hybrid", "v2/wagashi-open-a", "f48e192e29b38b8a215895894acaecf1a3e2e72cd6d176023985a7229ce47e0e", 7476],
  ["cafe/facts-pack.json", "C_hybrid", "v2/wagashi-open-b", "a8111237a8f388a69806343079b8a14e6ba73074d2aeeeb9db68fae9e298feab", 7358],
  ["cafe/facts-pack.json", "C_hybrid", "v3/wagashi-open-a", "fe9397ba674584a451c87df30a1f8f318fea5a6258a65be377a51cbdec8d2d47", 10074],
  ["cafe/facts-pack.json", "C_hybrid", "v3/wagashi-open-b", "dc117b5ade062b67aa945a2d620c8d9b54f232a0f37c27db76c4c1a368d6857e", 9956],
  ["cafe/facts-pack.json", "C_hybrid", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["wagashi/facts-pack.json", "B_html_prototype", "v1", "5d32ba950ce11f2da99eb6c3a07f7f3995cb6dbc5893955746662100269cbd22", 5682],
  ["wagashi/facts-pack.json", "B_html_prototype", "v1.1", "b6aaed382b52533ee2c9593c7a2adfd0cd283d65dfc3bfd60b97e7f363435902", 5986],
  ["wagashi/facts-pack.json", "B_html_prototype", "v1.1+research", "c3fceba2e4a992266ead00f5bf54afb8a84673bce44edb7b47826dd081a57d38", 7717],
  ["wagashi/facts-pack.json", "B_html_prototype", "v2/wagashi-open-a", "39c28a8560b836ea0ce37b3a64d8b09119e5e3c382e9153ee12478ebdc6101d9", 6972],
  ["wagashi/facts-pack.json", "B_html_prototype", "v2/wagashi-open-b", "057b27a781b3e3eab3125771cc2bf8c7e076aece4ebae71b343d1e6dc068fa19", 6854],
  ["wagashi/facts-pack.json", "B_html_prototype", "v3/wagashi-open-a", "a372d3af7fab1dc18042aa3b8344fd0922c3be001822a4c0846308dc8ac19525", 9570],
  ["wagashi/facts-pack.json", "B_html_prototype", "v3/wagashi-open-b", "aef5a9c63aecfff03cb7f8cdff9cdc9fa74b1a57e721f94e0fe46b1d07753a81", 9452],
  ["wagashi/facts-pack.json", "B_html_prototype", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["wagashi/facts-pack.json", "C_hybrid", "v1", "a25750d3af3f74a7e1e6825a97b093073f1615498aad541f4d5536d0ca1221d7", 6176],
  ["wagashi/facts-pack.json", "C_hybrid", "v1.1", "refused", "PROMPT_VARIANT_ROUTE"],
  ["wagashi/facts-pack.json", "C_hybrid", "v1.1+research", "refused", "PROMPT_VARIANT_ROUTE"],
  ["wagashi/facts-pack.json", "C_hybrid", "v2/wagashi-open-a", "41b79423c1892b7a883ddb6cb3ad67c3f311502de3cb1c02e916d7995face16f", 7418],
  ["wagashi/facts-pack.json", "C_hybrid", "v2/wagashi-open-b", "40450bb77b9762138a58d3226db7f395ab1cbb91e217e5e855b80e4727047a2a", 7300],
  ["wagashi/facts-pack.json", "C_hybrid", "v3/wagashi-open-a", "bc93008f6e44a535d5984062c0f5bfeb2fb7962c0976447940d10274f367924e", 10016],
  ["wagashi/facts-pack.json", "C_hybrid", "v3/wagashi-open-b", "4a1e559b870d394ad61ac8bca919ef6fbc334114b34e117bd51e326e4b55daa1", 9898],
  ["wagashi/facts-pack.json", "C_hybrid", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["bicycle/facts-pack.json", "B_html_prototype", "v1", "6076279c5f8ceb08d94a23c5727fdba7cd96e1434bc95d6c7a2d6f7642e2c989", 5711],
  ["bicycle/facts-pack.json", "B_html_prototype", "v1.1", "6bc8ef11a1d9cf417f05b1bc5748986462f9f75152eb1be03261876ab87587da", 6015],
  ["bicycle/facts-pack.json", "B_html_prototype", "v1.1+research", "b407c4adf6073bf46dec0088aa6a3bca6e6fa1a38f2dc533be05ac0b5d23fb80", 7746],
  ["bicycle/facts-pack.json", "B_html_prototype", "v2/wagashi-open-a", "6a33a1d2a9328dc66dc0f6efa6102eac5bffb12b469ef82bdb1e5d74137dfc2e", 7001],
  ["bicycle/facts-pack.json", "B_html_prototype", "v2/wagashi-open-b", "8c62f1a87e9336f0a1c0b7d8b20e19df9e55b19f22f8586fa5c63ee6ccf72a6b", 6883],
  ["bicycle/facts-pack.json", "B_html_prototype", "v3/wagashi-open-a", "67e4b9d6b7c7ab0125e4ae37a99994bbcb299dc1d0f71f2d725604aaccc0f4bc", 9599],
  ["bicycle/facts-pack.json", "B_html_prototype", "v3/wagashi-open-b", "9e66a15531264b3b4980ccc46c769496fb2e7596a64a5eb42e56d6abac90904c", 9481],
  ["bicycle/facts-pack.json", "B_html_prototype", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["bicycle/facts-pack.json", "C_hybrid", "v1", "f72d81981ed97f64181708d2884fa61fa07651d6d732a7d1149b70dbc9ad3dc1", 6205],
  ["bicycle/facts-pack.json", "C_hybrid", "v1.1", "refused", "PROMPT_VARIANT_ROUTE"],
  ["bicycle/facts-pack.json", "C_hybrid", "v1.1+research", "refused", "PROMPT_VARIANT_ROUTE"],
  ["bicycle/facts-pack.json", "C_hybrid", "v2/wagashi-open-a", "b2a119d8276c59102f30f4c109b057fd1f6caa63d898af5b210ad8fb1cfe719e", 7447],
  ["bicycle/facts-pack.json", "C_hybrid", "v2/wagashi-open-b", "69f795d920a07adb2b0fce0e27bcbde56a2e68f057de43725f5bfca1220ae0e1", 7329],
  ["bicycle/facts-pack.json", "C_hybrid", "v3/wagashi-open-a", "9a8ce46d386b3b0479495d7373f6932daa1dc33e12fd22c261b84b4f43e556e2", 10045],
  ["bicycle/facts-pack.json", "C_hybrid", "v3/wagashi-open-b", "64cb02c4569d5c40e56b788a060eb467ddd255aab3a439053c3072ae02a81974", 9927],
  ["bicycle/facts-pack.json", "C_hybrid", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["sendable-tamaki/facts-pack.json", "B_html_prototype", "v1", "554edb7245ce25f5869a1d1c73445a3a4aa8b1324a59b846b185bbf2a75fe3e1", 5712],
  ["sendable-tamaki/facts-pack.json", "B_html_prototype", "v1.1", "be25d86983740351cd028022e69cd393cf468623fb5d3bc96ffad2896dcf8005", 6016],
  ["sendable-tamaki/facts-pack.json", "B_html_prototype", "v1.1+research", "f2ad8bbe1ea4b5f32fd264e0b7634f56dcd813f95a0ec4c5bff068c175db22c9", 7747],
  ["sendable-tamaki/facts-pack.json", "B_html_prototype", "v2/wagashi-open-a", "f16894efa45671a5d06ef9d633c1554d1d8b8f593b12b28c87adf46c9aa8431b", 7002],
  ["sendable-tamaki/facts-pack.json", "B_html_prototype", "v2/wagashi-open-b", "07199d323a08c66462d9f04d99aa89a14bd563b2ce6f2be294095e57d9ff646c", 6884],
  ["sendable-tamaki/facts-pack.json", "B_html_prototype", "v3/wagashi-open-a", "23aac20ff8db102fa1261d7736372c04f5c9f3dadfb54713ad84224e683afbad", 9600],
  ["sendable-tamaki/facts-pack.json", "B_html_prototype", "v3/wagashi-open-b", "0222331960b15d477a24f1c6cb0ac157fb9380b15fe916c2a279c5091d94baab", 9482],
  ["sendable-tamaki/facts-pack.json", "B_html_prototype", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["sendable-tamaki/facts-pack.json", "C_hybrid", "v1", "15820681ed0e0549078cd80f40c638a1c4f60b6dbd880da5f730cee9ff36ea50", 6206],
  ["sendable-tamaki/facts-pack.json", "C_hybrid", "v1.1", "refused", "PROMPT_VARIANT_ROUTE"],
  ["sendable-tamaki/facts-pack.json", "C_hybrid", "v1.1+research", "refused", "PROMPT_VARIANT_ROUTE"],
  ["sendable-tamaki/facts-pack.json", "C_hybrid", "v2/wagashi-open-a", "11cf082e2be35780f9768839bc6269f526fbebe903c17a133a4593575e816512", 7448],
  ["sendable-tamaki/facts-pack.json", "C_hybrid", "v2/wagashi-open-b", "641bae5a283b3d3b6b9d3dfe235a946a93deda354530328b3dbbbda6168d73d3", 7330],
  ["sendable-tamaki/facts-pack.json", "C_hybrid", "v3/wagashi-open-a", "9f7d686085bedfca55e2acde05962861ac5efe4e579d1cdd59cf19b80192a268", 10046],
  ["sendable-tamaki/facts-pack.json", "C_hybrid", "v3/wagashi-open-b", "2612a8dc52c4e6d81694bdc883d248c6295e12b483e701e85119f24da6a38691", 9928],
  ["sendable-tamaki/facts-pack.json", "C_hybrid", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["sento/facts-pack.json", "B_html_prototype", "v1", "6bc89b5fbcaecf48e9ae0affd1b4440edd23388c483e1cd74cfee2ee97969175", 5661],
  ["sento/facts-pack.json", "B_html_prototype", "v1.1", "d6bb05eed998f764af1284c5e8ace0724c37fb457b02c72fd62222f6cbc01c68", 5965],
  ["sento/facts-pack.json", "B_html_prototype", "v1.1+research", "f9ff0857b6823ddfe37d65ea79d323199c45568afefb054657a651205fa7817e", 7696],
  ["sento/facts-pack.json", "B_html_prototype", "v2/wagashi-open-a", "efe9bcd5ad0d7043f3af5e924503cb0d32939cadf17f48d7d0fffefd72be3459", 6951],
  ["sento/facts-pack.json", "B_html_prototype", "v2/wagashi-open-b", "14c2eba7366f01674e389ba3e64d53e3b03f2680f7096f188e42a7cc2513b305", 6833],
  ["sento/facts-pack.json", "B_html_prototype", "v3/wagashi-open-a", "04f4c5c420a98902df2af001ec087c82fa6d44f8a350794a6afacdc23a6fff05", 9549],
  ["sento/facts-pack.json", "B_html_prototype", "v3/wagashi-open-b", "ec83507241c9dba778a0050841c52910108e1681a2a44d945c3cc2fd38804078", 9431],
  ["sento/facts-pack.json", "B_html_prototype", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["sento/facts-pack.json", "C_hybrid", "v1", "a22bd48c70a5ec423f0303de975d192e9f51a916ba769a9007b99468f7055452", 6155],
  ["sento/facts-pack.json", "C_hybrid", "v1.1", "refused", "PROMPT_VARIANT_ROUTE"],
  ["sento/facts-pack.json", "C_hybrid", "v1.1+research", "refused", "PROMPT_VARIANT_ROUTE"],
  ["sento/facts-pack.json", "C_hybrid", "v2/wagashi-open-a", "47813ca995f2f005a91285af366d16669c9c98d418d58a483d80aab2e0396bd9", 7397],
  ["sento/facts-pack.json", "C_hybrid", "v2/wagashi-open-b", "a5e00f43cab23322ddddf7637585edc7844f296f2888a0e3b960170030e623fe", 7279],
  ["sento/facts-pack.json", "C_hybrid", "v3/wagashi-open-a", "58f919602cce608c0023ee1d81a1d595f0b84f322683652ca6a5441d50710e80", 9995],
  ["sento/facts-pack.json", "C_hybrid", "v3/wagashi-open-b", "8931d399d721ffc6b7b4677905ee73783e05472e966908d4437b6276757bd832", 9877],
  ["sento/facts-pack.json", "C_hybrid", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["tsugute/facts-pack.json", "B_html_prototype", "v1", "6103a1e405c98a507c31f064498e394c386c2c6f89978e4faf28054903829d76", 5654],
  ["tsugute/facts-pack.json", "B_html_prototype", "v1.1", "3d08e3b45f47110ae28177bda164e9420a2683680cd812f7af283dafe49adf7f", 5958],
  ["tsugute/facts-pack.json", "B_html_prototype", "v1.1+research", "db908a4efc4d2f1ed925e36c499f155a3e51a8c7606da6978451348e75423cf8", 7689],
  ["tsugute/facts-pack.json", "B_html_prototype", "v2/wagashi-open-a", "0e569c811cf2eb8c9471298dca87d8793467f6fa662c3526ef732759fba1ca67", 6944],
  ["tsugute/facts-pack.json", "B_html_prototype", "v2/wagashi-open-b", "72f86f2c70cb5022fe1d8eac761939eb58f350cc143239ae19efb6b1dc618530", 6826],
  ["tsugute/facts-pack.json", "B_html_prototype", "v3/wagashi-open-a", "4ad550a1ce895e62d94b5b4cfe5805e9fb883f4e335cd381b2b662a9c5873c06", 9542],
  ["tsugute/facts-pack.json", "B_html_prototype", "v3/wagashi-open-b", "ea31ad37ec5512586579b9a302db657b269b9f66e9f060e90bcac8c2c7211600", 9424],
  ["tsugute/facts-pack.json", "B_html_prototype", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
  ["tsugute/facts-pack.json", "C_hybrid", "v1", "b063b2a82606e6176143445df7249813e124a0979e011a1492fa0f9fc6dbdb3f", 6148],
  ["tsugute/facts-pack.json", "C_hybrid", "v1.1", "refused", "PROMPT_VARIANT_ROUTE"],
  ["tsugute/facts-pack.json", "C_hybrid", "v1.1+research", "refused", "PROMPT_VARIANT_ROUTE"],
  ["tsugute/facts-pack.json", "C_hybrid", "v2/wagashi-open-a", "052ad62e5891cf3905e4c329b3f31e1c352296af956f1dd8d5eec4da454e52aa", 7390],
  ["tsugute/facts-pack.json", "C_hybrid", "v2/wagashi-open-b", "73b84a851c6d516eddf8f535ab0a1a6e6168ba2ce9a4299c5e0ee0f8a78603ed", 7272],
  ["tsugute/facts-pack.json", "C_hybrid", "v3/wagashi-open-a", "08bcca11ee60c90909befcaa40a97043a4f1777b9cc0275cd874778e71892079", 9988],
  ["tsugute/facts-pack.json", "C_hybrid", "v3/wagashi-open-b", "1027ec37b68286d361127009f0823a4b9f21c019a45e97f3b9ee08c7b4e060a4", 9870],
  ["tsugute/facts-pack.json", "C_hybrid", "tm0", "refused", "PROMPT_VARIANT_BRIEF"],
];

describe("prompt versions before v2.1 are unchanged (pinned from develop 5af70616)", () => {
  it("covers every facts fixture, both routes and every version (144 combinations, 110 built)", () => {
    expect(new Set(PINNED.map((p) => p[0]))).toEqual(new Set(Object.keys(PACKS)));
    // every committed facts pack fixture is pinned (a new one must be added here)
    const committed = readdirSync(resolve(REPO, "design-library"), { recursive: true, encoding: "utf8" }).filter((f) => /facts-pack\.json$/.test(f)).map((f) => `design-library/${f}`).sort();
    expect(committed).toEqual(Object.values(PACKS).sort());
    expect(PINNED).toHaveLength(144);
    expect(PINNED.filter((p) => p[3] !== "refused")).toHaveLength(110);
  });

  it.each(PINNED)("%s %s %s", (packKey, route, name, sha, chars) => {
    const v = VARIANTS[name]!;
    const build = () => buildDesignPrompt({ route, facts: FactsPack.parse(read(PACKS[packKey]!)), maxAssets: 1, variant: v.variant, ...(v.brief ? { brief } : {}) });
    if (sha === "refused") {
      expect(build).toThrow(String(chars));
      return;
    }
    const built = build();
    expect([built.sha256, built.chars]).toEqual([sha, chars]);
  });
});
