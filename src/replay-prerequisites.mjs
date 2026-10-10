// Static evidence only: wrappers, aliases and expressions may hide dependencies.
// Never expose the host Docker socket to make a workflow replayable.
export function dockerDaemonRequirement(jobs) {
  for (const job of jobs) {
    for (const step of job.steps || []) {
      const action = /^(?:docker\/(?:setup-buildx-action|build-push-action))@/.test(step.uses || '');
      const command = (step.run || '').split('\n').some(line =>
        /(?:^|[;&|])\s*(?:sudo\s+)?docker(?:-compose\b|\s+(?:run|build|buildx|compose|exec|pull|push|create|start|stop|rm|ps|info|inspect|network|volume)\b)/.test(line));
      if (action || command) return { job: job.id, line: step.line, reason: 'docker-daemon-unavailable-in-replay' };
    }
  }
  return null;
}
