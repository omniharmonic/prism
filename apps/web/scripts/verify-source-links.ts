import assert from "node:assert/strict";
import { sourceLinkTarget, sourceContextMatches } from "../src/native/sourceLinks.ts";
const path = "/source/primary/note-1?server=https%3A%2F%2Fworkspace.example&paired=1";
const target = sourceLinkTarget(path)!;
assert.deepEqual(target, {kind:"source", vault:"primary", id:"note-1", server:"https://workspace.example", paired:true});
assert.equal(sourceContextMatches(target, "https://workspace.example", {authenticated:true,vaultId:"primary"}), true);
for (const [origin, identity] of [
  ["https://other.example", {authenticated:true,vaultId:"primary"}],
  ["https://workspace.example", {authenticated:true,vaultId:"other"}],
  ["https://workspace.example", {authenticated:false,vaultId:"primary"}],
  ["https://workspace.example", null],
] as const) assert.equal(sourceContextMatches(target, origin, identity), false);
assert.equal(sourceContextMatches({...target,paired:false}, "https://workspace.example", {authenticated:true,vaultId:"primary"}), false);
for (const invalid of [path+"&extra=1", path+"&server=https://other.example", path.replace("paired=1","paired=yes"), path.replace("note-1","%2F"), path.replace("https%3A%2F%2Fworkspace.example","https%3A%2F%2Fu%3Ap%40workspace.example"), path.replace("https%3A%2F%2Fworkspace.example","https%3A%2F%2Fworkspace.example%2Fprivate")]) assert.equal(sourceLinkTarget(invalid), null);
console.log("Contextual source parsing and workspace mismatch regressions passed");
