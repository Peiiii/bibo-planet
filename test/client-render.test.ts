import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderSpiritText } from "../src/client/app.tsx";

test("spirit emphasis renders without exposing raw markup or HTML", () => {
  const content = renderSpiritText("叫它**追风签**。<script>no</script>");
  const html = renderToStaticMarkup(createElement("p", null, content));
  assert.equal(
    html,
    "<p>叫它<strong>追风签</strong>。&lt;script&gt;no&lt;/script&gt;</p>",
  );
});
