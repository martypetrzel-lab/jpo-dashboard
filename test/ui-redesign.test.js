import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const css=fs.readFileSync(new URL("../public/interface.css",import.meta.url),"utf8");
const app=fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");

test("workspace navigation exposes the core product areas without duplicating pages",()=>{
  for(const view of ["overview","events","map","analytics","regions","reports","talk","admin"])
    assert.match(html,new RegExp(`data-workspace="${view}"`));
  assert.match(app,/const WORKSPACE_VIEWS/);
  assert.match(app,/setWorkspaceView/);
  for(const id of ["overviewOpenCount","overviewTotalCount","overviewClosedCount","overviewMajorCount","overviewMapCount","overviewMissingCount"])
    assert.match(html,new RegExp(`id="${id}"`));
});

test("event filters share period, region and search state through the URL",()=>{
  for(const period of ["today","yesterday","last7","last30","custom"])
    assert.match(html,new RegExp(`option value="${period}"`));
  assert.match(app,/syncUrlWithFilters/);
  assert.match(app,/restoreUiFromUrl/);
  assert.match(app,/activeFilterChips/);
});

test("responsive UI uses mobile cards, accessible targets and reduced motion",()=>{
  assert.match(css,/\.desktopEventsTable\s*\{display:none !important;\}/);
  assert.match(css,/\.eventsMobileList\s*\{display:grid !important;\}/);
  assert.match(css,/min-height:44px/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(html,/aria-label="Zapnout celou obrazovku"/);
});
