import { Collection, Cursor } from "mongodb";

import { MongoContext } from "coral-server/data/context";
import { StoryNotFoundError } from "coral-server/errors";
import { Logger } from "coral-server/logger";
import {
  createEmptyRelatedCommentCounts,
  RelatedCommentCounts,
  updateSharedCommentCounts,
} from "coral-server/models/comment/counts";
import { updateSiteCounts } from "coral-server/models/site";
import { Story } from "coral-server/models/story";
import {
  archivedCommentActions,
  archivedCommentModerationActions,
  archivedComments,
  commentActions,
  commentModerationActions,
  comments,
  stories,
} from "coral-server/services/mongodb/collections";
import { AugmentedRedis } from "coral-server/services/redis";

const getCommentCounts = (options: {
  story: Readonly<Story>;
  negate: boolean;
}) => {
  const {
    story: { commentCounts },
    negate,
  } = options;
  const multiplier = negate ? -1 : 1;

  const result: RelatedCommentCounts = createEmptyRelatedCommentCounts();

  if (commentCounts.action) {
    for (const key in commentCounts.action) {
      if (result.action.hasOwnProperty.call(commentCounts.action, key)) {
        const value = commentCounts.action[key];
        result.action[key] = value * multiplier;
      }
    }
  }

  if (commentCounts.moderationQueue) {
    result.moderationQueue.total =
      commentCounts.moderationQueue.total * multiplier;

    let key: keyof typeof commentCounts.moderationQueue.queues;
    for (key in commentCounts.moderationQueue.queues) {
      if (
        result.moderationQueue.queues.hasOwnProperty.call(
          commentCounts.moderationQueue.queues,
          key
        )
      ) {
        const value = commentCounts.moderationQueue.queues[key];
        result.moderationQueue.queues[key] = value * multiplier;
      }
    }
  }

  if (commentCounts.status) {
    let key: keyof typeof commentCounts.status;
    for (key in commentCounts.status) {
      if (result.status.hasOwnProperty.call(commentCounts.status, key)) {
        const value = commentCounts.status[key];
        result.status[key] = value * multiplier;
      }
    }
  }

  return result;
};

export async function archiveStory(
  mongo: MongoContext,
  redis: AugmentedRedis,
  tenantID: string,
  id: string,
  log: Logger
) {
  if (!mongo.archive) {
    throw new Error("Cannot archive, archive connection is not initialized");
  }

  const logger = log.child({ storyID: id });
  logger.info("starting to archive story");

  const targetStory = await stories(mongo.live).findOne({ id, tenantID });
  if (!targetStory) {
    throw new StoryNotFoundError(id);
  }

  if (targetStory.isArchived) {
    logger.info("story is already archived, exiting");
    return;
  }

  logger.info("story is able to be archived, proceeding");

  const targetComments = comments(mongo.live).find({
    tenantID,
    storyID: id,
  });
  const targetCommentActions = commentActions(mongo.live).find({
    tenantID,
    storyID: id,
  });

  logger.info("archiving comments");
  const targetCommentIDs = await moveDocuments({
    tenantID,
    source: comments(mongo.live),
    selectionCursor: targetComments,
    destination: archivedComments(mongo.archive),
    returnMovedIDs: true,
  });

  const targetCommentModerationActions = commentModerationActions(
    mongo.live
  ).find({
    tenantID,
    commentID: { $in: targetCommentIDs },
  });

  logger.info("archiving comment actions");
  await moveDocuments({
    tenantID,
    source: commentActions(mongo.live),
    selectionCursor: targetCommentActions,
    destination: archivedCommentActions(mongo.archive),
  });
  logger.info("archiving comment moderation actions");
  await moveDocuments({
    tenantID,
    source: commentModerationActions(mongo.live),
    selectionCursor: targetCommentModerationActions,
    destination: archivedCommentModerationActions(mongo.archive),
  });

  // negate the comment counts so we can subtract them from the
  // site and shared comment counts
  const commentCounts = getCommentCounts({
    story: targetStory,
    negate: true,
  });

  logger.info("updating site counts for archive");
  await updateSiteCounts(mongo.live, tenantID, id, commentCounts);
  logger.info("updating shared counts for archive");
  await updateSharedCommentCounts(redis, tenantID, commentCounts);

  logger.info("marking story as archived");
  const result = await stories(mongo.live).findOneAndUpdate(
    { id, tenantID },
    {
      $set: {
        isArchiving: false,
        isArchived: true,
      },
    },
    {
      returnOriginal: false,
    }
  );

  logger.info("completed archiving tasks");
  return result.value;
}

export async function unarchiveStory(
  mongo: MongoContext,
  redis: AugmentedRedis,
  tenantID: string,
  id: string,
  log: Logger
) {
  if (!mongo.archive) {
    throw new Error("Cannot archive, archive connection is not initialized");
  }

  const logger = log.child({ storyID: id });
  logger.info("starting to unarchive story");

  const targetStory = await stories(mongo.live).findOne({ id, tenantID });
  if (!targetStory) {
    throw new StoryNotFoundError(id);
  }

  if (!targetStory.isArchived) {
    logger.info("story is not archived, exiting");
    return;
  }

  logger.info("story is able to be unarchived, proceeding");

  const targetComments = archivedComments(mongo.archive).find({
    tenantID,
    storyID: id,
  });
  const targetCommentActions = archivedCommentActions(mongo.archive).find({
    tenantID,
    storyID: id,
  });

  logger.info("unarchiving comments");
  const targetCommentIDs = await moveDocuments({
    tenantID,
    source: archivedComments(mongo.archive),
    selectionCursor: targetComments,
    destination: comments(mongo.live),
    returnMovedIDs: true,
  });

  const targetCommentModerationActions = archivedCommentModerationActions(
    mongo.archive
  ).find({
    tenantID,
    commentID: { $in: targetCommentIDs },
  });

  logger.info("unarchiving comment actions");
  await moveDocuments({
    tenantID,
    source: archivedCommentActions(mongo.archive),
    selectionCursor: targetCommentActions,
    destination: commentActions(mongo.live),
  });

  logger.info("unarchiving comment moderation actions");
  await moveDocuments({
    tenantID,
    source: archivedCommentModerationActions(mongo.archive),
    selectionCursor: targetCommentModerationActions,
    destination: commentModerationActions(mongo.live),
  });

  // get the comment counts so we can add them to the
  // site and shared comment counts
  const commentCounts = getCommentCounts({
    story: targetStory,
    negate: false,
  });

  logger.info("updating site counts for unarchive");
  await updateSiteCounts(mongo.live, tenantID, id, commentCounts);

  logger.info("updating shared counts for unarchive");
  await updateSharedCommentCounts(redis, tenantID, commentCounts);

  logger.info("marking story as unarchived");
  const result = await stories(mongo.live).findOneAndUpdate(
    { id, tenantID },
    {
      $set: {
        isArchiving: false,
        isArchived: false,
      },
    },
    {
      returnOriginal: false,
    }
  );

  logger.info("completed unarchiving tasks");
  return result.value;
}

interface MoveDocumentsOptions {
  tenantID: string;
  source: Collection;
  selectionCursor: Cursor;
  destination: Collection;
  returnMovedIDs?: boolean;
}

const BATCH_SIZE = 100;
const moveDocuments = async ({
  tenantID,
  source,
  selectionCursor,
  destination,
  returnMovedIDs = false,
}: MoveDocumentsOptions) => {
  let insertBatch: any[] = [];
  let deleteIDs: string[] = [];
  const allIDs: string[] = [];

  while (await selectionCursor.hasNext()) {
    const document = await selectionCursor.next();
    if (!document) {
      continue;
    }

    insertBatch.push(document);

    const hasID = Object.prototype.hasOwnProperty.call(document, "id");
    if (hasID) {
      deleteIDs.push(document.id);
    }
    if (hasID && returnMovedIDs) {
      allIDs.push(document.id);
    }

    if (insertBatch.length >= BATCH_SIZE) {
      const bulkInsert = destination.initializeUnorderedBulkOp();
      for (const item of insertBatch) {
        bulkInsert.insert(item);
      }
      await bulkInsert.execute();

      const bulkDelete = source.initializeUnorderedBulkOp();
      bulkDelete.find({ tenantID, id: { $in: deleteIDs } }).remove();
      await bulkDelete.execute();

      insertBatch = [];
      deleteIDs = [];
    }
  }

  if (insertBatch.length > 0) {
    const bulkInsert = destination.initializeUnorderedBulkOp();
    for (const item of insertBatch) {
      bulkInsert.insert(item);
    }
    await bulkInsert.execute();
  }
  if (deleteIDs.length > 0) {
    const bulkDelete = source.initializeUnorderedBulkOp();
    bulkDelete.find({ tenantID, id: { $in: deleteIDs } }).remove();
    await bulkDelete.execute();
  }

  return allIDs;
};
