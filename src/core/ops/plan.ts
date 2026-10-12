import * as path from 'node:path';
import { diffModels, type ChangeSet } from '../mirror/diff';
import { BASE_DIR } from '../mirror/layout';
import { readModel, type MirrorModel, type ParseProblem } from '../mirror/model';
import type { MirrorState } from '../mirror/state';
import { validateModel, type Issue } from '../mirror/validate';
import { isServerContainer } from './pull';

export interface WorkingStatus {
  readonly changes: ChangeSet;
  readonly issues: readonly Issue[];
  readonly problems: readonly ParseProblem[];
  readonly conflicts: readonly string[];
  readonly local: MirrorModel;
  readonly base: MirrorModel;
}

/** Local-only: what Push would do right now, and what blocks it. No API calls. */
export async function workingStatus(root: string, state: MirrorState): Promise<WorkingStatus> {
  const isServer = isServerContainer(state);
  const localRead = await readModel(root, isServer);
  const base = (await readModel(path.join(root, BASE_DIR), isServer)).model;
  const builtInNames = new Map(Object.entries(state.builtInNames));
  return {
    changes: diffModels(localRead.model, base, state),
    issues: validateModel(localRead.model, builtInNames),
    problems: localRead.problems,
    conflicts: state.conflicts,
    local: localRead.model,
    base,
  };
}
