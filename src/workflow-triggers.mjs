// Whether a workflow would be triggered by one event, per GitHub's documented
// filter rules (on.<event>.branches/tags/paths and their -ignore forms).
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#filter-pattern-cheat-sheet
// Anything not modelled here is `unknown`, never `not-triggered`.

const PR_DEFAULT_TYPES = ['opened', 'synchronize', 'reopened'];

// GitHub filter pattern -> anchored RegExp. `*` stops at `/`, `**` does not,
// `?` and `+` quantify the preceding character, `[...]` is a class, `\` escapes.
export function filterPattern(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    // `**/` also matches zero directories (`**/README.md` includes the root one).
    if (c === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
    else if (c === '*' && pattern[i + 1] === '*') { out += '.*'; i += 1; }
    else if (c === '*') out += '[^/]*';
    else if ((c === '?' || c === '+') && out) out += c;
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) throw new Error('invalid-filter-pattern');
      out += pattern.slice(i, end + 1).replace(/\\/g, '\\\\');
      i = end;
    } else if (c === '\\' && i + 1 < pattern.length) { out += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i += 1; }
    else out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

// Ordered include/exclude list: later patterns override earlier ones.
export function matchList(value, patterns) {
  let matched = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    if (filterPattern(negated ? raw.slice(1) : raw).test(value)) matched = !negated;
  }
  return matched;
}

/**
 * @param workflow parsed workflow (parseWorkflow)
 * @param context { event, ref: 'refs/heads/x' | 'refs/tags/v1', targetBranch (pull_request base), changedFiles: string[] | null }
 */
export function evaluateTrigger(workflow, { event, ref, targetBranch, changedFiles }) {
  const trigger = workflow.triggers.find(item => item.event === event);
  if (!trigger) return { status: 'not-triggered', reasons: [`event ${event} is not declared (declared: ${workflow.triggers.map(t => t.event).join(', ') || 'none'})`] };
  const f = trigger.filters;
  const reasons = [];
  try {
    if (event === 'push') {
      const isTag = ref.startsWith('refs/tags/');
      const name = ref.replace(/^refs\/(heads|tags)\//, '');
      const own = isTag ? ['tags', 'tags-ignore'] : ['branches', 'branches-ignore'];
      const other = isTag ? ['branches', 'branches-ignore'] : ['tags', 'tags-ignore'];
      const hasOwn = own.some(key => f[key]);
      // Only the other kind of ref filter is set: this kind of ref never triggers.
      if (!hasOwn && other.some(key => f[key])) return { status: 'not-triggered', reasons: [`push filters only ${other[0]}; ${name} is a ${isTag ? 'tag' : 'branch'}`] };
      if (f[own[0]] && !matchList(name, f[own[0]])) return { status: 'not-triggered', reasons: [`${name} does not match on.push.${own[0]}`] };
      if (f[own[1]] && matchList(name, f[own[1]])) return { status: 'not-triggered', reasons: [`${name} matches on.push.${own[1]}`] };
      if (hasOwn) reasons.push(`${name} passes on.push.${own[0]}/${own[1]}`);
      if (isTag && (f.paths || f['paths-ignore'])) reasons.push('paths filters are not evaluated for tag pushes');
    } else if (event === 'pull_request' || event === 'pull_request_target') {
      if (f.types && !PR_DEFAULT_TYPES.some(type => f.types.includes(type))) {
        return { status: 'unknown', reasons: [`on.${event}.types (${f.types.join(', ')}) depends on the PR action`] };
      }
      if (f.branches || f['branches-ignore']) {
        if (!targetBranch) return { status: 'unknown', reasons: ['target branch unknown for branches filter'] };
        if (f.branches && !matchList(targetBranch, f.branches)) return { status: 'not-triggered', reasons: [`target ${targetBranch} does not match on.${event}.branches`] };
        if (f['branches-ignore'] && matchList(targetBranch, f['branches-ignore'])) return { status: 'not-triggered', reasons: [`target ${targetBranch} matches on.${event}.branches-ignore`] };
        reasons.push(`target ${targetBranch} passes branch filters`);
      }
    } else if (event !== 'workflow_dispatch') {
      return { status: 'unknown', reasons: [`event ${event} filters are not modelled`] };
    }
    if ((f.paths || f['paths-ignore']) && !(event === 'push' && ref.startsWith('refs/tags/'))) {
      if (!changedFiles) return { status: 'unknown', reasons: [...reasons, 'changed files unknown for paths filter'] };
      if (f.paths) {
        const hit = changedFiles.find(file => matchList(file, f.paths));
        if (!hit) return { status: 'not-triggered', reasons: [...reasons, `no changed file matches on.${event}.paths`] };
        reasons.push(`${hit} matches on.${event}.paths`);
      } else {
        const kept = changedFiles.find(file => !matchList(file, f['paths-ignore']));
        if (!kept) return { status: 'not-triggered', reasons: [...reasons, `every changed file matches on.${event}.paths-ignore`] };
        reasons.push(`${kept} is not ignored by on.${event}.paths-ignore`);
      }
    }
  } catch {
    return { status: 'unknown', reasons: ['unsupported filter pattern'] };
  }
  return { status: 'triggered', reasons: reasons.length ? reasons : [`on.${event} has no filters`] };
}
