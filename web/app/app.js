/* US Recession Monitor — Telegram Mini App.
 * Renders the same data.{locale}.json the static site serves (schema:
 * src/site/dataJson.ts — server-generated, fully localized via `labels`).
 * Inside Telegram: theme + language come from initDataUnsafe (display only —
 * the payload is public, no initData validation is needed). Outside Telegram
 * it degrades to a plain dark page. */
(function () {
  var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  var STATE_DOT = { ok: "#3fb950", watch: "#d29922", warning: "#f0883e", critical: "#f85149" };

  function pickLocale() {
    var lang =
      (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code) ||
      (navigator.language || "en");
    lang = String(lang).slice(0, 2).toLowerCase();
    // Any 2-letter code passes through — unsupported locales fall back to
    // ../data.json in tryLoad, so adding a locale needs no JS change (F14).
    return /^[a-z]{2}$/.test(lang) ? lang : "en";
  }

  function applyTheme() {
    if (!tg || !tg.themeParams) return;
    var p = tg.themeParams;
    var vars = {
      "--bg": p.bg_color,
      "--panel": p.secondary_bg_color,
      "--text": p.text_color,
      "--muted": p.hint_color,
      "--low": p.link_color,
    };
    for (var k in vars) {
      if (vars[k]) document.documentElement.style.setProperty(k, vars[k]);
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function render(d, base) {
    var L = d.labels || {};
    var html = "";

    html += '<div class="verdict" style="color:' + esc(d.bucket_color || "#58a6ff") + '">' +
            esc(String(d.bucket).toUpperCase()) + "</div>";
    html += '<div class="prob">' + esc(L.score || "Score") + " <b>" +
            (d.score != null ? Number(d.score).toFixed(1) : "—") + "</b>" +
            (d.model_prob_label ? " · " + esc(d.model_prob_label) : "") + "</div>";

    var trend = d.trend || [];
    if (trend.length) {
      html += '<div class="panel"><h2>' + esc(L.trend_90d || "Trend") + '</h2><div class="spark">';
      var scale = d.score_scale || 14; // server-provided (model.yaml bands)
      for (var i = 0; i < trend.length; i++) {
        // [ts, score] pairs; tolerate plain numbers from older payloads
        var v = Array.isArray(trend[i]) ? trend[i][1] : trend[i];
        var h = Math.max(4, Math.round((Math.min(v, scale) / scale) * 100));
        var last = i === trend.length - 1;
        html += '<div style="height:' + h + "%" + (last ? ";background:" + esc(d.bucket_color || "") : "") + '"></div>';
      }
      html += "</div></div>";
    }

    if (d.active && d.active.length) {
      html += '<div class="panel"><h2>' + esc(L.active || "Active signals") + "</h2>";
      for (var j = 0; j < d.active.length; j++) {
        var s = d.active[j];
        var dot = STATE_DOT[s.state] || "#8b949e";
        html += '<span class="chip"><span class="dot" style="background:' + dot + '"></span>' +
                esc(s.name) + ' <b>' + esc(s.value || "") + "</b></span>";
      }
      html += "</div>";
    }

    html += '<div class="panel"><h2>' + esc(L.nowcast || "Nowcast") + "</h2>";
    if (d.nowcast && d.nowcast.length) {
      for (var k = 0; k < d.nowcast.length; k++) {
        var n = d.nowcast[k];
        html += '<div class="now"><span>' + esc(n.name) + '</span><span class="v">' + esc(n.value || "—") + "</span></div>";
      }
    } else {
      html += '<div class="now"><span>' + esc(L.nowcast_calm || "All calm") + "</span></div>";
    }
    html += "</div>";

    var updated = (d.generated_at || "?").slice(0, 16).replace("T", " ");
    html += '<div class="meta">' + esc(L.updated || "Updated") + ": " + esc(updated) + " UTC</div>";
    html += '<footer><a href="' + base + '">' + esc(L.title || "Full dashboard") + "</a></footer>";

    document.getElementById("root").innerHTML = html;
    document.title = (L.title || "US Recession Monitor") + " — " + String(d.bucket).toUpperCase();
  }

  function fail(msg) {
    document.getElementById("root").innerHTML = '<p class="error">' + esc(msg) + "</p>";
  }

  if (tg) {
    applyTheme();
    tg.ready();
    tg.expand();
  }

  var locale = pickLocale();
  var candidates = ["../data." + locale + ".json", "../data.json"];
  (function tryLoad(i) {
    if (i >= candidates.length) return fail("Failed to load data");
    fetch(candidates[i])
      .then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(function (d) {
        render(d, "../index.html");
      })
      .catch(function () {
        tryLoad(i + 1);
      });
  })(0);
})();
