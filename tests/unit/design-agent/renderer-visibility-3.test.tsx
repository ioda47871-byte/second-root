import { defineVisibilityTests } from "./renderer-visibility-support";

// DEV-071b: the visibleChanges pixel safety net, part 3 of 3 (VISIBILITY_PARTS; the parts run in parallel files).
defineVisibilityTests(2);
