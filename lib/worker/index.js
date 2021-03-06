const Queue = require('bull')

const { discovery } = require('../sync/discovery')
const { processPullRequests } = require('../sync/pull-request')
const { processCommits } = require('../sync/commits.js')
const { processBranches } = require('../sync/branches.js')
const { processPush } = require('../transforms/push')

const limiterPerInstallation = require('./limiter')

const app = require('./app')

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379'
const { CONCURRENT_WORKERS = 1 } = process.env

// Setup queues
const queues = {
  discovery: new Queue('Content discovery', REDIS_URL),
  pullRequests: new Queue('Pull Requests transformation', REDIS_URL),
  commits: new Queue('Commit transformation', REDIS_URL),
  branches: new Queue('Branch transformation', REDIS_URL),
  push: new Queue('Push transformation', REDIS_URL)
}

// Setup error handling for queues
Object.keys(queues).forEach(name => {
  const queue = queues[name]

  queue.on('error', (err) => {
    app.log.error({ err, queue: name })
  })

  queue.on('failed', (job, err) => {
    app.log.error({ job, err, queue: name })
  })
})

module.exports = {
  queues,

  start () {
    queues.pullRequests.process(Number(CONCURRENT_WORKERS), limiterPerInstallation(processPullRequests(app, queues)))
    queues.commits.process(Number(CONCURRENT_WORKERS), limiterPerInstallation(processCommits(app, queues)))
    queues.branches.process(Number(CONCURRENT_WORKERS), limiterPerInstallation(processBranches(app, queues)))
    queues.discovery.process(5, limiterPerInstallation(discovery(app, queues)))
    queues.push.process(Number(CONCURRENT_WORKERS), limiterPerInstallation(processPush(app)))
    app.log(`Worker process started with ${CONCURRENT_WORKERS} CONCURRENT WORKERS`)
  },

  async clean () {
    return Promise.all([
      queues.discovery.clean(10000, 'completed'),
      queues.discovery.clean(10000, 'failed'),
      queues.pullRequests.clean(10000, 'completed'),
      queues.pullRequests.clean(10000, 'failed'),
      queues.commits.clean(10000, 'completed'),
      queues.commits.clean(10000, 'failed'),
      queues.branches.clean(10000, 'completed'),
      queues.branches.clean(10000, 'failed'),
      queues.push.clean(10000, 'completed'),
      queues.push.clean(10000, 'failed')
    ])
  },

  async stop () {
    return Promise.all([
      queues.pullRequests.close(),
      queues.commits.close(),
      queues.branches.close(),
      queues.discovery.close(),
      queues.push.close()
    ])
  }
}
