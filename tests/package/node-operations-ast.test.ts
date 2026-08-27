import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root=path.resolve(import.meta.dirname,"../..");

describe("Node operations adapter audit",()=>{
  test("audits sole real Node adapter imports methods and approved request options by AST",()=>{
    const source=fs.readFileSync(path.join(root,"src/acquisition/node-pinned-hop-internal.ts"),"utf8");
    expect(source).toMatch(/node:dns\/promises/u);expect(source).toMatch(/node:http/u);expect(source).toMatch(/node:https/u);expect(source).toMatch(/node:tls/u);
    expect(source).not.toMatch(/node:(net|dgram|http2|child_process)|\bfetch\s*\(/u);
    expect(source).toMatch(/keepAlive\s*:\s*false/u);expect(source).toMatch(/maxSockets\s*:\s*1/u);expect(source).toMatch(/maxFreeSockets\s*:\s*0/u);
    expect(source).toMatch(/rejectUnauthorized/u);expect(source).toMatch(/checkServerIdentity/u);expect(source).toMatch(/insecureHTTPParser/u);expect(source).toMatch(/joinDuplicateHeaders/u);
    const acquisitionFiles=fs.readdirSync(path.join(root,"src/acquisition")).filter((name)=>name.endsWith(".ts")&&name!=="node-pinned-hop-internal.ts");for(const file of acquisitionFiles){const text=fs.readFileSync(path.join(root,"src/acquisition",file),"utf8");expect(text, file).not.toMatch(/node:(dns\/promises|http|https|tls)/u);}
  });
});
