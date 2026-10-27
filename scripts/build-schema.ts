// Writes the published JSON Schema of the snapshot contract from lib/graph/schema.ts: npm run schema.
import { writeFileSync } from "node:fs";
import { infraGraphJsonSchema } from "@/lib/graph/schema";

const path = "schema/infra-graph.v1.schema.json";
writeFileSync(path, `${JSON.stringify(infraGraphJsonSchema(), null, 2)}\n`);
console.log(`wrote ${path}`);
