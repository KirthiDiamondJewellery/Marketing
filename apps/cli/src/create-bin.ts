#!/usr/bin/env node
import "./builtins.ts";
import { createMain } from "./main.ts";

process.exitCode = await createMain(process.argv.slice(2));
