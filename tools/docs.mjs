#!/usr/bin/env node
// Bilingual Markdown structure checks and changelog-derived release notes.
// Adapted from the maintainer's oss-readiness documentation utility.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ZH = '.zh-TW.md'
const CATEGORIES = { Added: '新增', Changed: '變更', Deprecated: '棄用', Removed: '移除', Fixed: '修正', Security: '安全性' }
const UNRELEASED = { en: 'Unreleased', zh: '未發布' }


export function skeleton(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const sections = [{ level: 0, title: '', bullets: 0, rows: 0, images: 0, code: 0 }]
  const links = new Set()
  const spans = new Set()
  const codeBlocks = []
  let codeText = []
  let fence = false
  for (const line of lines) {
    const cur = sections[sections.length - 1]
    if (/^\s*(```|~~~)/.test(line)) {
      if (!fence) { cur.code += 1; codeText = [] }
      else codeBlocks.push(codeText.join('\n'))
      fence = !fence
      continue
    }
    if (fence) { codeText.push(line); continue }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      sections.push({ level: h[1].length, title: h[2].trim(), bullets: 0, rows: 0, images: 0, code: 0 })
      continue
    }
    if (/^(- |\* |\d+\. )/.test(line)) cur.bullets += 1
    if (/^\|/.test(line) && !/^\|[\s:|-]+\|\s*$/.test(line)) cur.rows += 1
    cur.images += (line.match(/<img\s|!\[/g) ?? []).length
    for (const m of line.matchAll(/\]\(([^)\s]+)\)|(?:href|src)="([^"]+)"/g)) {
      const target = m[1] ?? m[2]
      if (target && !target.startsWith('#')) links.add(target)
    }
    const def = /^\[[^\]]+\]:\s*(\S+)/.exec(line)
    if (def?.[1]) links.add(def[1])
    for (const m of line.matchAll(/`([^`]+)`/g)) if (m[1]) spans.add(sameTarget(m[1].replace(/<[^<>]+>/g, '<…>')))
  }
  return { sections, links, spans, codeBlocks, unclosedFence: fence }
}

function changelogKey(title) {
  const v = /\[?(\d+\.\d+\.\d+[^\]\s]*)\]?/.exec(title)
  if (v) return `v${v[1]}`
  if (title.includes(UNRELEASED.en) || title.includes(UNRELEASED.zh)) return 'unreleased'
  for (const [en, zh] of Object.entries(CATEGORIES)) if (title === en || title === zh) return en
  return title
}

const sameTarget = t => t.replace(/#.*$/, '').replace(/\.zh-TW\.md$/, '.md')


export function compare(en, zh, { changelog = false } = {}) {
  const a = skeleton(en)
  const b = skeleton(zh)
  const problems = []
  if (a.unclosedFence || b.unclosedFence) problems.push('Unclosed code fence')
  if (JSON.stringify(a.codeBlocks) !== JSON.stringify(b.codeBlocks)) problems.push('Code block contents differ between languages')
  const name = s => s.title || '(start)'
  if (a.sections.length !== b.sections.length) {
    problems.push(`Different heading count: English ${a.sections.length - 1}; Traditional Chinese ${b.sections.length - 1}`)
  }
  const n = Math.min(a.sections.length, b.sections.length)
  for (let i = 0; i < n; i++) {
    const x = a.sections[i]
    const y = b.sections[i]
    if (x.level !== y.level) {
      problems.push(`第 ${i}標題層級不同：「${name(x)}」(h${x.level}) ↔ 「${name(y)}」(h${y.level})`)
      break
    }
    if (changelog && x.level >= 2 && changelogKey(x.title) !== changelogKey(y.title)) {
      problems.push(`CHANGELOG heading mismatch: 「${name(x)}」↔「${name(y)}」`)
      break
    }
    for (const [k, label] of [['bullets', 'list items'], ['rows', 'table rows'], ['images', 'images'], ['code', 'code blocks']]) {
      if (x[k] !== y[k]) problems.push(`「${name(x)}」↔「${name(y)}」 ${label} counts differ: ${x[k]} ↔ ${y[k]}`)
    }
  }
  const la = new Set([...a.links].map(sameTarget))
  const lb = new Set([...b.links].map(sameTarget))
  for (const l of la) if (!lb.has(l)) problems.push(`Traditional Chinese missing link: ${l}`)
  for (const l of lb) if (!la.has(l)) problems.push(`English missing link: ${l}`)
  for (const s of a.spans) if (!b.spans.has(s)) problems.push(`Traditional Chinese missing inline code: \`${s}\``)
  for (const s of b.spans) if (!a.spans.has(s)) problems.push(`English missing inline code: \`${s}\``)
  return problems
}

export function pairs(dir) {
  const out = []
  for (const sub of ['', 'docs', '.github']) {
    const d = join(dir, sub)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) {
      if (!f.endsWith(ZH)) continue
      const en = join(d, f.slice(0, -ZH.length) + '.md')
      out.push({ en, zh: join(d, f), exists: existsSync(en) })
    }
  }
  return out
}


export function versionSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(l => /^## /.test(l) && changelogKey(l.slice(3)) === `v${version}`)
  if (start < 0) return undefined
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (end < 0) end = lines.length
  const body = lines.slice(start + 1, end).filter(l => !/^\[[^\]]+\]:\s*\S+/.test(l)).join('\n').trim()
  const def = lines.find(l => l.startsWith(`[${version}]:`))
  const link = def ? def.slice(version.length + 3).trim() : undefined
  return { body, link }
}

export function releaseNotes(enText, zhText, version) {
  const en = versionSection(enText, version)
  const zh = versionSection(zhText, version)
  if (!en || !zh) return undefined
  const demote = s => s.replace(/^### /gm, '#### ')
  return [
    demote(en.body),
    '',
    '---',
    '',
    '### 繁體中文',
    '',
    demote(zh.body),
    ...(en.link ? ['', `**Full changelog / 完整差異：** ${en.link}`] : []),
    '',
  ].join('\n')
}


const [cmd, ...rest] = process.argv.slice(2)
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (cmd === 'check') {
    const dir = resolve(rest[0] ?? '.')
    let bad = 0
    const found = pairs(dir)
    for (const p of found) {
      const rel = p.zh.slice(dir.length + 1)
      if (!p.exists) { console.log(`✗ ${rel}: missing English source`); bad += 1; continue }
      const problems = compare(readFileSync(p.en, 'utf8'), readFileSync(p.zh, 'utf8'), { changelog: /CHANGELOG/i.test(p.en) })
      if (problems.length) {
        bad += 1
        console.log(`✗ ${rel}`)
        for (const x of problems) console.log(`  ${x}`)
      } else console.log(`✓ ${rel}`)
    }
    for (const f of ['README.md', 'CHANGELOG.md']) {
      if (existsSync(join(dir, f)) && !existsSync(join(dir, f.replace(/\.md$/, ZH)))) { console.log(`✗ ${f}: missing Traditional Chinese version`); bad += 1 }
    }
    console.log(bad ? `${bad} documents differ` : `${found.length} bilingual document pairs match`)
    process.exit(bad ? 1 : 0)
  } else if (cmd === 'release' && rest[0]) {
    const dir = resolve(rest[1] ?? '.')
    const out = releaseNotes(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), readFileSync(join(dir, `CHANGELOG${ZH}`), 'utf8'), rest[0])
    if (!out) { console.error(`Both changelogs must include version ${rest[0]}`); process.exit(1) }
    process.stdout.write(out)
  } else {
    console.error('Usage: node tools/docs.mjs check [directory] | release <version> [directory]')
    process.exit(2)
  }
}
