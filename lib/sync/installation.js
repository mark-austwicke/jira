const tasks = {
  pull: require('./pull-request').getPullRequests,
  branch: require('./branches').getBranches,
  commit: require('./commits').getCommits
}
const taskTypes = Object.keys(tasks)

const getNextTask = (subscription) => {
  const repos = subscription.get('repoSyncState').repos
  return Object.values(repos)
    .find(repoStatus => {
      const task = taskTypes.find(taskType => repoStatus[`${taskType}Status`] !== 'complete')
      if (!task) return
      const { repository } = repoStatus
      return { task, repository }
    })
}

module.exports.processInstallation = (app, queues) => {

  const updateJobStatus = async (jiraClient, job, edges, jobType) => {
    const { installationId, jiraHost, repository } = job.data
    // Get a fresh subscription instance
    const subscription = await Subscription.getSingleInstallation(jiraHost, installationId)

    const status = edges.length > 0 ? 'pending' : 'complete'
    app.log(`Updating job status for ${jobInfo(installationId, repository, jobType)}, status=${status}`)
    subscription.set(`repoSyncState.repos.${repository.id}.${jobType}Status`, status)
    if (edges.length > 0) {
      // there's more data to get
      subscription.set(`repoSyncState.repos.${repository.id}.${getCursorKey(jobType)}`, edges[edges.length - 1].cursor)
      const { removeOnComplete, removeOnFail } = job.opts
      queues.installation.add(job.data, { removeOnComplete, removeOnFail })
    } else {
      // no more data (last page was processed of this job type)
      if (!getNextTask(subscription)) {
        subscription.set('syncStatus', 'COMPLETE')
        app.log(`Sync status for installationId=${installationId} is complete`)
        try {
          await jiraClient.devinfo.migration.complete()
        } catch (err) {
          app.log.error(err || 'Error sending the `complete` event to JIRA')
        }
      } else {
        const pendingRepoIds = pendingRepos.map(([id]) => id).join(', ')
        app.log(`Sync status for installationId=${installationId} is active. Pending repositories: ${pendingRepoIds}`)
      }
    }
    await subscription.save()
  }

  return async function (job) {
    const { installationId, jiraHost, repository } = job.data
    app.log(`Starting job for ${jobInfo(installationId, repository, jobType)}`)

    const subscription = await Subscription.getSingleInstallation(jiraHost, installationId)
    if (!subscription) return

    const jiraClient = await getJiraClient(subscription.id, installationId, subscription.jiraHost)
    const github = await app.auth(installationId)

    const nextTask = getNextTask(subscription)
    if (!nextTask) return

    await subscription.update({ syncStatus: 'ACTIVE' })

    const { task, repository } = nextTask
    const processor = tasks[task]

    const pagedProcessor = (perPage) => {
      return processor(jiraClient, github, repository, cursor, perPage)
    }

    const execute = () => {
      try {
        return pagedProcessor(100)
      } catch (err) {
        // if github times out, try with
        // return pagedProcessor(50)

        // if rate limited, delay job

        // otherwise
        throw err
      }
    }

    const edges = await execute()

    await updateJobStatus(jiraClient, job, edges, task)
  }
}