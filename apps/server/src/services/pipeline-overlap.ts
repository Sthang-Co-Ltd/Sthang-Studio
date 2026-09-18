export interface PrimaryOverlapResult<TTask, TFollowup> {
  tasks: [PromiseSettledResult<TTask>, PromiseSettledResult<TTask>];
  primaryFollowup: PromiseSettledResult<TFollowup>;
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
}

/**
 * Start the primary task's dependent work as soon as that task resolves while an
 * independent secondary task is still running. Both task results are still
 * collected before the caller decides how to handle failures or deduplicate work.
 */
export async function settlePairWithPrimaryFollowup<TTask, TFollowup>(
  primaryTask: Promise<TTask>,
  secondaryTask: Promise<TTask>,
  primaryFollowup: (value: TTask) => Promise<TFollowup>,
): Promise<PrimaryOverlapResult<TTask, TFollowup>> {
  const primaryFollowupResult = settle(primaryTask.then(primaryFollowup));
  const tasks = await Promise.allSettled([primaryTask, secondaryTask]);
  return {
    tasks: tasks as [PromiseSettledResult<TTask>, PromiseSettledResult<TTask>],
    primaryFollowup: await primaryFollowupResult,
  };
}
