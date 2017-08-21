const {SubscriptionManager} = require('graphql-subscriptions');
const {SubscriptionServer} = require('subscriptions-transport-ws');
const _ = require('lodash');
const debug = require('debug')('talk:graph:subscriptions');

const pubsub = require('../services/pubsub');
const schema = require('./schema');
const Context = require('./context');
const plugins = require('../services/plugins');

const {deserializeUser} = require('../services/subscriptions');

const ms = require('ms');
const {
  KEEP_ALIVE
} = require('../config');

const {
  SUBSCRIBE_COMMENT_ACCEPTED,
  SUBSCRIBE_COMMENT_REJECTED,
  SUBSCRIBE_COMMENT_FLAGGED,
  SUBSCRIBE_ALL_COMMENT_EDITED,
  SUBSCRIBE_ALL_COMMENT_ADDED,
  SUBSCRIBE_ALL_USER_SUSPENDED,
  SUBSCRIBE_ALL_USER_BANNED,
  SUBSCRIBE_ALL_USERNAME_REJECTED,
} = require('../perms/constants');

const {BASE_PATH} = require('../url');

/**
 * Plugin support requires that we merge in existing setupFunctions with our new
 * plugin based ones. This allows plugins to extend existing setupFunctions as well
 * as provide new ones.
 */
const setupFunctions = plugins.get('server', 'setupFunctions').reduce((acc, {plugin, setupFunctions}) => {
  debug(`added plugin '${plugin.name}'`);

  return _.merge(acc, setupFunctions);
}, {
  commentAdded: (options, args) => ({
    commentAdded: {
      filter: (comment, context) => {
        if (!args.asset_id && (!context.user || !context.user.can(SUBSCRIBE_ALL_COMMENT_ADDED))) {
          return false;
        }
        return !args.asset_id || comment.asset_id === args.asset_id;
      }
    },
  }),
  commentEdited: (options, args) => ({
    commentEdited: {
      filter: (comment, context) => {
        if (!args.asset_id && (!context.user || !context.user.can(SUBSCRIBE_ALL_COMMENT_EDITED))) {
          return false;
        }
        return !args.asset_id || comment.asset_id === args.asset_id;
      }
    },
  }),
  commentFlagged: (options, args) => ({
    commentFlagged: {
      filter: (comment, context) => {
        if (!context.user || !context.user.can(SUBSCRIBE_COMMENT_FLAGGED)) {
          return false;
        }
        return !args.asset_id || comment.asset_id === args.asset_id;
      }
    },
  }),
  commentAccepted: (options, args) => ({
    commentAccepted: {
      filter: (comment, context) => {
        if (!context.user || !context.user.can(SUBSCRIBE_COMMENT_ACCEPTED)) {
          return false;
        }
        return !args.asset_id || comment.asset_id === args.asset_id;
      }
    },
  }),
  commentRejected: (options, args) => ({
    commentRejected: {
      filter: (comment, context) => {
        if (!context.user || !context.user.can(SUBSCRIBE_COMMENT_REJECTED)) {
          return false;
        }
        return !args.asset_id || comment.asset_id === args.asset_id;
      }
    },
  }),
  userSuspended: (options, args) => ({
    userSuspended: {
      filter: (user, context) => {
        if (
          !context.user
          || args.user_id !== user.id && !context.user.can(SUBSCRIBE_ALL_USER_SUSPENDED)
        ) {
          return false;
        }
        return !args.user_id || user.id === args.user_id;
      }
    },
  }),
  userBanned: (options, args) => ({
    userBanned: {
      filter: (user, context) => {
        if (
          !context.user
          || args.user_id !== user.id && !context.user.can(SUBSCRIBE_ALL_USER_BANNED)
        ) {
          return false;
        }
        return !args.user_id || user.id === args.user_id;
      }
    },
  }),
  usernameRejected: (options, args) => ({
    usernameRejected: {
      filter: (user, context) => {
        if (
          !context.user
          || args.user_id !== user.id && !context.user.can(SUBSCRIBE_ALL_USERNAME_REJECTED)
        ) {
          return false;
        }
        return !args.user_id || user.id === args.user_id;
      }
    },
  }),
});

/**
 * This creates a new subscription manager.
 */
const createSubscriptionManager = (server) => new SubscriptionServer({
  subscriptionManager: new SubscriptionManager({
    schema,
    pubsub: pubsub.getClient(),
    setupFunctions,
  }),
  onConnect: ({token}, connection) => {

    // Attach the token from the connection options if it was provided.
    if (token) {

      // Attach it to the upgrade request.
      connection.upgradeReq.headers['authorization'] = `Bearer ${token}`;
    }
  },
  onOperation: (parsedMessage, baseParams, connection) => {

    // Cache the upgrade request.
    let upgradeReq = connection.upgradeReq;

    // Attach the context per request.
    baseParams.context = async () => {
      let req;

      try {
        req = await deserializeUser(upgradeReq);
      } catch (e) {
        console.error(e);

        return new Context({});
      }

      return new Context(req);
    };

    return baseParams;
  },
  keepAlive: ms(KEEP_ALIVE)
}, {
  server,
  path: `${BASE_PATH}api/v1/live`
});

module.exports = {
  createSubscriptionManager
};
