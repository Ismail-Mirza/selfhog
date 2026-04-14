#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");

const SKILLS = ["deploy-posthog.md", "posthog-health.md"];
const TARGET_DIR = path.join(os.homedir(), ".claude", "commands");
const SKILLS_DIR = path.join(__dirname, "..", "skills");

function install() {
  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
  }

  let installed = [];
  for (const skill of SKILLS) {
    const src = path.join(SKILLS_DIR, skill);
    const dest = path.join(TARGET_DIR, skill);
    fs.copyFileSync(src, dest);
    installed.push(skill.replace(".md", ""));
  }

  console.log("\n✅ selfhog skills installed!\n");
  console.log("Available slash commands in Claude Code:");
  for (const name of installed) {
    console.log(`  /${name}`);
  }
  console.log("\nUsage:");
  console.log("  /deploy-posthog   — full guided deployment on a fresh VPS");
  console.log("  /posthog-health   — diagnose and fix a running PostHog stack\n");
}

install();
