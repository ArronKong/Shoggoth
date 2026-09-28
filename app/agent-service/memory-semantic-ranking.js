"use strict";

// A retrieval cutoff, not a calibrated fact confidence. Its product fixture
// and independent holdout are evaluated separately from lexical regression.
const SEMANTIC_MIN_COSINE = 0.70;
const normalize = text => String(text).normalize("NFKC").toLocaleLowerCase().trim();

function literalQuery(query) {
  const normalized = normalize(query);
  const quoted = /^(?:"[^"]+"|“[^”]+”|「[^」]+」)$/u.test(normalized);
  return quoted ? normalized.slice(1, -1) : normalized;
}

function preferLiteral(query, text) {
  const normalized = normalize(query);
  const literal = literalQuery(query);
  const identifier = /^[\p{L}\p{N}_.:/@-]+$/u.test(literal) && /[\d_.:/@-]/u.test(literal);
  const shortHan = /^[\p{Script=Han}]{1,2}$/u.test(literal);
  return !!literal && (literal !== normalized || identifier || shortHan) && normalize(text).includes(literal);
}

function sourceLanguage(text) {
  const letters = String(text).match(/\p{Letter}/gu) || [];
  const han = letters.filter(letter => /\p{Script=Han}/u.test(letter)).length;
  return han > letters.length / 2 ? "han" : "other";
}

function createLanguageScoreCenter() {
  const groups = new Map();
  let sum=0, count=0;
  return {
    add(language, score) {
      const group=groups.get(language) || {sum:0,count:0};
      group.sum+=score;group.count++;groups.set(language,group);sum+=score;count++;
    },
    offset(language) {
      const group=groups.get(language);
      return group?.count>=5 ? group.sum/group.count : count ? sum/count : 0;
    },
  };
}

function centerLanguageScores(rows) {
  const center = createLanguageScoreCenter();
  for (const row of rows) {
    center.add(row.source?.language ?? row.language, row.score);
  }
  return rows.map(row=>({...row,rankScore:row.score-center.offset(row.source?.language ?? row.language)}));
}

function hybridScore(query, text, lexicalScore, semanticScore, rankScore = null) {
  const exact = preferLiteral(query, text);
  const semantic = Number.isFinite(semanticScore) && semanticScore >= SEMANTIC_MIN_COSINE;
  return { score: (exact ? 2 : 0) + (semantic ? Number.isFinite(rankScore)
    ? 0.5+Math.max(-1,Math.min(1,rankScore))*0.5 : semanticScore : Math.max(0, Math.min(1, lexicalScore)) * 0.1),
    scoreBasis: semantic ? Number.isFinite(rankScore) ? "e5-language-centered-cosine" : "e5-cosine" : exact ? "lexical-exact" : "lexical",
    ...(semantic ? { semanticScore } : {}) };
}

module.exports = { SEMANTIC_MIN_COSINE, normalize, literalQuery, preferLiteral, hybridScore,
  sourceLanguage, centerLanguageScores, createLanguageScoreCenter };
