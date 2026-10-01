import { z } from "zod";
export const TerminalProfileSchema = z
    .object({
    id: z.string(),
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    icon: z.string().optional(),
})
    .passthrough();
//# sourceMappingURL=terminal-profile.js.map