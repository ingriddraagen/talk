import { isEmpty } from "lodash";
import { Collection, Db } from "mongodb";
import * as uuid from "uuid";

import { RequireProperty, Sub } from "coral-common/types";
import { dotize } from "coral-common/utils/dotize";
import {
  CommentEditWindowExpiredError,
  CommentNotFoundError,
  CommentRevisionNotFoundError,
} from "coral-server/errors";
import { createTimer } from "coral-server/helpers";
import logger from "coral-server/logger";
import {
  EncodedCommentActionCounts,
  mergeCommentActionCounts,
} from "coral-server/models/action/comment";
import {
  Connection,
  createConnection,
  doesNotContainNull,
  FilterQuery,
  nodesToEdges,
  NodeToCursorTransformer,
  OrderedConnectionInput,
  Query,
  resolveConnection,
} from "coral-server/models/helpers";
import { TenantResource } from "coral-server/models/tenant";
import { comments } from "coral-server/services/mongodb/collections";

import {
  GQLCOMMENT_SORT,
  GQLCOMMENT_STATUS,
  GQLCommentTagCounts,
  GQLTAG,
} from "coral-server/graph/schema/__generated__/types";

import { PUBLISHED_STATUSES } from "./constants";
import { CommentStatusCounts, createEmptyCommentStatusCounts } from "./counts";
import { hasAncestors } from "./helpers";
import { Revision } from "./revision";
import { CommentTag } from "./tag";

/**
 * Comment's are created by User's on Stories. Each Comment contains a body, and
 * can be moderated by another Moderator or Admin User.
 */
export interface Comment extends TenantResource {
  /**
   * id identifies this Comment specifically.
   */
  readonly id: string;

  /**
   * ancestorIDs stores all the ancestor ID's, with the direct parent being
   * first.
   */
  ancestorIDs: string[];

  /**
   * parentID is the ID of the parent Comment if this Comment is a reply.
   */
  parentID?: string;

  /**
   * parentRevisionID is the ID of the Revision on the Comment referenced by the
   * `parentID`.
   */
  parentRevisionID?: string;

  /**
   * authorID stores the ID of the User that created this Comment.
   */
  authorID: string | null;

  /**
   * storyID stores the ID of the Story that this Comment was left on.
   */
  storyID: string;

  /**
   * siteID stores the ID of the Site that this Comment was left on.
   */
  siteID: string;

  /**
   * section is the section of the story that this comment was left on. If the
   * section was not available when the comment was authored, the section will
   * be null here.
   */
  section?: string;

  /**
   * revisions stores all the revisions of the Comment body including the most
   * recent revision, the last revision is the most recent.
   */
  revisions: Revision[];

  /**
   * status is the current Comment Status.
   */
  status: GQLCOMMENT_STATUS;

  /**
   * actionCounts stores a cached count of all the Action's against this
   * Comment.
   */
  actionCounts: EncodedCommentActionCounts;

  /**
   * childIDs are the ID's of all the Comment's that are direct replies.
   */
  childIDs: string[];

  /**
   * tags are CommentTag's on a specific Comment to be showcased with the
   * Comment.
   */
  tags: CommentTag[];

  /**
   * rating is the optional value for the current rating linked to this Comment.
   */
  rating?: number;

  /**
   * childCount is the count of direct replies. It is stored as a separate value
   * here even though the childIDs field technically contained the same data in
   * it's length because we needed to sort by this field sometimes.
   */
  childCount: number;

  /**
   * createdAt is the date that this Comment was created.
   */
  createdAt: Date;

  /**
   * deletedAt is the date that this Comment was deleted on. If null or
   * undefined, this Comment is not deleted.
   */
  deletedAt?: Date;
}

export type CreateCommentInput = Omit<
  Comment,
  | "id"
  | "tenantID"
  | "createdAt"
  | "childIDs"
  | "childCount"
  | "actionCounts"
  | "revisions"
  | "deletedAt"
> &
  Required<Pick<Revision, "body">> &
  Pick<Revision, "metadata" | "media"> &
  Partial<Pick<Comment, "actionCounts" | "siteID">>;

export async function createComment(
  mongo: Db,
  tenantID: string,
  input: CreateCommentInput,
  now = new Date()
) {
  // Pull out some useful properties from the input.
  const { body, actionCounts = {}, metadata, media, ...rest } = input;

  // Generate the revision.
  const revision: Readonly<Revision> = {
    id: uuid.v4(),
    body,
    actionCounts,
    metadata,
    createdAt: now,
    media,
  };

  // default are the properties set by the application when a new comment is
  // created.
  const defaults: Sub<Comment, CreateCommentInput> = {
    id: uuid.v4(),
    tenantID,
    childIDs: [],
    childCount: 0,
    revisions: [revision],
    createdAt: now,
  };

  // Merge the defaults and the input together.
  const comment: Readonly<Comment> = {
    // Defaults for things that always stay the same, or are computed.
    ...defaults,
    // Rest for things that are passed in and are not actionCounts.
    ...rest,
    // ActionCounts because they may be passed in!
    actionCounts,
  };

  // Insert it into the database.
  await comments(mongo).insertOne(comment);

  return { comment, revision };
}

/**
 * pushChildCommentIDOntoParent will push the new child comment's ID onto the
 * parent comment so it can reference direct children.
 */
export async function pushChildCommentIDOntoParent(
  mongo: Db,
  tenantID: string,
  parentID: string,
  childID: string
) {
  // This pushes the new child ID onto the parent comment.
  const result = await comments(mongo).findOneAndUpdate(
    {
      tenantID,
      id: parentID,
    },
    {
      $push: { childIDs: childID },
      $inc: { childCount: 1 },
    }
  );

  return result.value;
}

export type EditCommentInput = Pick<Comment, "id" | "authorID" | "status"> & {
  /**
   * lastEditableCommentCreatedAt is the date that the last comment would have
   * been editable. It is generally derived from the tenant's
   * `editCommentWindowLength` property.
   */
  lastEditableCommentCreatedAt: Date;
} & Required<Pick<Revision, "body" | "metadata">> &
  Pick<Revision, "media"> &
  Partial<Pick<Comment, "actionCounts">>;

// Only comments with the following status's can be edited.
const EDITABLE_STATUSES = [
  GQLCOMMENT_STATUS.NONE,
  GQLCOMMENT_STATUS.PREMOD,
  GQLCOMMENT_STATUS.APPROVED,
];

export function validateEditable(
  comment: Comment,
  {
    authorID,
    lastEditableCommentCreatedAt,
  }: Pick<EditCommentInput, "authorID" | "lastEditableCommentCreatedAt">
) {
  if (comment.authorID !== authorID) {
    // TODO: (wyattjoh) return better error
    throw new Error("comment author mismatch");
  }

  // Check to see if the comment had a status that was editable.
  if (!EDITABLE_STATUSES.includes(comment.status)) {
    // TODO: (wyattjoh) return better error
    throw new Error("comment status is not editable");
  }

  // Check to see if the edit window expired.
  if (comment.createdAt <= lastEditableCommentCreatedAt) {
    throw new CommentEditWindowExpiredError(comment.id);
  }
}

export interface EditComment {
  /**
   * before is the comment before the edit.
   */
  before: Readonly<Comment>;

  /**
   * after is the comment after the edit.
   */
  after: Readonly<Comment>;

  /**
   * revision is the new revision generated.
   */
  revision: Readonly<Revision>;
}

/**
 * editComment will edit a comment if it's within the time allotment.
 *
 * @param mongo MongoDB database handle
 * @param tenantID ID for the Tenant where the Comment exists
 * @param input input for editing the comment
 */
export async function editComment(
  mongo: Db,
  tenantID: string,
  input: EditCommentInput,
  now = new Date()
): Promise<EditComment> {
  const {
    id,
    body,
    lastEditableCommentCreatedAt,
    status,
    authorID,
    metadata,
    media,
    actionCounts = {},
  } = input;

  const revision: Revision = {
    id: uuid.v4(),
    body,
    actionCounts,
    metadata,
    createdAt: now,
    media,
  };

  const update: Record<string, any> = {
    $set: { status },
    $push: {
      revisions: revision,
    },
  };
  if (!isEmpty(actionCounts)) {
    // Action counts are being provided! Increment the base action counts too!
    update.$inc = dotize({ actionCounts });
  }

  const result = await comments(mongo).findOneAndUpdate(
    {
      id,
      tenantID,
      authorID,
      status: {
        $in: EDITABLE_STATUSES,
      },
      deletedAt: undefined,
      createdAt: {
        $gt: lastEditableCommentCreatedAt,
      },
    },
    update,
    {
      // True to return the original document instead of the updated document.
      returnOriginal: true,
    }
  );
  if (!result.value) {
    // Try to get the comment.
    const comment = await retrieveComment(mongo, tenantID, id);
    if (!comment) {
      // TODO: (wyattjoh) return better error
      throw new Error("comment not found");
    }

    // Validate and potentially return with a more useful error.
    validateEditable(comment, input);

    // TODO: (wyattjoh) return better error
    throw new Error("comment edit failed for an unexpected reason");
  }

  // Create a new "after" where the same changes were applied to it as
  // we did to the MongoDB document.
  const after: Comment = {
    ...result.value,
    // $set status
    status,
    // $inc actionCounts
    actionCounts: mergeCommentActionCounts(
      result.value.actionCounts,
      actionCounts
    ),
    // $push revisions
    revisions: [...result.value.revisions, revision],
  };

  return {
    before: result.value,
    after,
    revision,
  };
}

export async function retrieveComment(mongo: Db, tenantID: string, id: string) {
  return await comments(mongo).findOne({ id, tenantID });
}

export async function retrieveManyComments(
  collection: Collection<Readonly<Comment>>,
  tenantID: string,
  ids: ReadonlyArray<string>
) {
  // Try and find it in live comments collection
  const cursor = collection.find({
    id: {
      $in: ids,
    },
    tenantID,
  });

  const items = await cursor.toArray();
  if (items.length > 0) {
    return ids.map((id) => items.find((comment) => comment.id === id) || null);
  }

  return [];
}

export type CommentConnectionInput = OrderedConnectionInput<
  Comment,
  GQLCOMMENT_SORT
>;

function cursorGetterFactory(
  input: Pick<CommentConnectionInput, "orderBy" | "after">
): NodeToCursorTransformer<Comment> {
  switch (input.orderBy) {
    case GQLCOMMENT_SORT.CREATED_AT_DESC:
    case GQLCOMMENT_SORT.CREATED_AT_ASC:
      return (comment) => comment.createdAt;
    case GQLCOMMENT_SORT.REPLIES_DESC:
    case GQLCOMMENT_SORT.REACTION_DESC:
      return (_, index) =>
        (input.after ? (input.after as number) : 0) + index + 1;
  }
}

/**
 * retrieveRepliesConnection returns a Connection<Comment> for a given comments
 * replies.
 *
 * @param mongo database connection
 * @param tenantID the tenant id
 * @param storyID the id of the story the comment belongs to
 * @param parentID the parent id for the comment to retrieve
 * @param input connection configuration
 */
export const retrieveCommentRepliesConnection = (
  collection: Collection<Readonly<Comment>>,
  tenantID: string,
  storyID: string,
  parentID: string,
  input: CommentConnectionInput
) => {
  const filter: any = {
    parentID,
    ...input.filter,
    storyID,
  };

  return retrievePublishedCommentConnection(collection, tenantID, {
    ...input,
    filter,
  });
};

/**
 * retrieveCommentParentsConnection will return a comment connection used to
 * represent the parents of a given comment.
 *
 * @param mongo the database connection to use when retrieving comments
 * @param tenantID the tenant id for where the comment exists
 * @param comment the comment to retrieve parents of
 * @param pagination pagination options to paginate the results
 */
export async function retrieveCommentParentsConnection(
  collection: Collection<Readonly<Comment>>,
  tenantID: string,
  comment: Comment,
  { last: limit, before: skip = 0 }: { last: number; before?: number }
): Promise<Readonly<Connection<Readonly<Comment>>>> {
  // Return nothing if this comment does not have any parents.
  if (!hasAncestors(comment)) {
    return createConnection({
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
  }

  // TODO: (wyattjoh) maybe throw an error when the limit is zero?

  if (limit <= 0) {
    return createConnection({
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: true,
        endCursor: 0,
        startCursor: 0,
      },
    });
  }

  // Fetch the subset of the comment id's that we are going to query for.
  const ancestorIDs = comment.ancestorIDs.slice(skip, skip + limit);

  // Retrieve the parents via the subset list.
  const nodes = await retrieveManyComments(collection, tenantID, ancestorIDs);

  // Loop over the list to ensure that none of the entries is null (indicating
  // that there was a misplaced parent). We can assert the type here because we
  // will throw an error and abort if one of the comments are null.
  if (!doesNotContainNull(nodes)) {
    // TODO: (wyattjoh) replace with a better error.
    throw new Error("parent id specified does not exist");
  }

  const edges = nodesToEdges(
    // We can't have a null parent after the forEach filter above.
    nodes,
    (_, index) => index + skip + 1
  ).reverse();

  // Return the resolved connection.
  return {
    edges,
    nodes,
    pageInfo: {
      hasNextPage: false,
      hasPreviousPage: comment.ancestorIDs.length > limit + skip,
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    },
  };
}

/**
 * retrieveStoryConnection returns a Connection<Comment> for a given Stories
 * comments.
 *
 * @param mongo database connection
 * @param tenantID the Tenant id
 * @param storyID the Story id for the comment to retrieve
 * @param input connection configuration
 */
export const retrieveCommentStoryConnection = (
  collection: Collection<Readonly<Comment>>,
  tenantID: string,
  storyID: string,
  input: CommentConnectionInput
) =>
  retrievePublishedCommentConnection(collection, tenantID, {
    ...input,
    filter: {
      ...input.filter,
      storyID,
    },
  });

/**
 * retrieveCommentUserConnection returns a Connection<Comment> for a given User's
 * comments.
 *
 * @param mongo database connection
 * @param tenantID the Tenant's ID
 * @param userID the User id for the comment to retrieve
 * @param input connection configuration
 */
export const retrieveCommentUserConnection = (
  collection: Collection<Readonly<Comment>>,
  tenantID: string,
  userID: string,
  input: CommentConnectionInput
) =>
  retrievePublishedCommentConnection(collection, tenantID, {
    ...input,
    filter: {
      ...input.filter,
      authorID: userID,
    },
  });

/**
 * retrieveAllCommentUserConnection returns a Connection<Comment> for a given User's
 * comments regardless of comment status.
 *
 * @param mongo database connection
 * @param tenantID the Tenant's ID
 * @param userID the User id for the comment to retrieve
 * @param input connection configuration
 */
export const retrieveAllCommentsUserConnection = (
  collection: Collection<Readonly<Comment>>,
  tenantID: string,
  userID: string,
  input: CommentConnectionInput
) =>
  retrieveCommentConnection(collection, tenantID, {
    ...input,
    filter: {
      ...input.filter,
      authorID: userID,
    },
  });

/**
 * retrieveRejectedCommentUserConnection returns a Connection<Comment> for a given User's
 * rejected comments.
 *
 * @param mongo database connection
 * @param tenantID the Tenant's ID
 * @param userID the User id for the comment to retrieve
 * @param input connection configuration
 */
export const retrieveRejectedCommentUserConnection = (
  collection: Collection<Readonly<Comment>>,
  tenantID: string,
  userID: string,
  input: CommentConnectionInput
) =>
  retrieveStatusCommentConnection(
    collection,
    tenantID,
    [GQLCOMMENT_STATUS.REJECTED],
    {
      ...input,
      filter: {
        ...input.filter,
        authorID: userID,
      },
    }
  );

/**
 * retrievePublishedCommentConnection will retrieve a connection that contains
 * comments that are published.
 *
 * @param mongo database connection
 * @param tenantID the Tenant's ID
 * @param input connection configuration
 */
export const retrievePublishedCommentConnection = (
  collection: Collection<Readonly<Comment>>,
  tenantID: string,
  input: CommentConnectionInput
) =>
  retrieveStatusCommentConnection(
    collection,
    tenantID,
    PUBLISHED_STATUSES,
    input
  );

/**
 * retrieveStatusCommentConnection will retrieve a connection that contains
 * comments with specific statuses.
 *
 * @param mongo database connection
 * @param tenantID the Tenant's ID
 * @param statuses the statuses to filter
 * @param input connection configuration
 */
export const retrieveStatusCommentConnection = (
  collection: Collection<Readonly<Comment>>,
  tenantID: string,
  statuses: GQLCOMMENT_STATUS[],
  input: CommentConnectionInput
) =>
  retrieveCommentConnection(collection, tenantID, {
    ...input,
    filter: {
      ...input.filter,
      status: { $in: statuses },
    },
  });

export async function retrieveCommentConnection(
  collection: Collection<Readonly<Comment>>,
  tenantID: string,
  input: CommentConnectionInput
): Promise<Readonly<Connection<Readonly<Comment>>>> {
  // Create the query.
  const query = new Query(collection).where({ tenantID });

  // If a filter is being applied, filter it as well.
  if (input.filter) {
    query.where(input.filter);
  }

  return retrieveConnection(input, query);
}

/**
 * retrieveConnection returns a Connection<Comment> for the given input and
 * Query.
 *
 * @param input connection configuration
 * @param query the Query for the set of nodes that should have the connection
 *              configuration applied
 */
const retrieveConnection = async (
  input: CommentConnectionInput,
  query: Query<Comment>
): Promise<Readonly<Connection<Readonly<Comment>>>> =>
  resolveConnection(
    applyInputToQuery(input, query),
    input,
    cursorGetterFactory(input)
  );

function applyInputToQuery(
  input: CommentConnectionInput,
  query: Query<Comment>
) {
  // NOTE: (wyattjoh) if we ever extend these, ensure that the new order variant is added as an index into the `createConnectionOrderVariants` function.
  switch (input.orderBy) {
    case GQLCOMMENT_SORT.CREATED_AT_DESC:
      query.orderBy({ createdAt: -1 });
      if (input.after) {
        query.where({ createdAt: { $lt: input.after as Date } });
      }
      return query;
    case GQLCOMMENT_SORT.CREATED_AT_ASC:
      query.orderBy({ createdAt: 1 });
      if (input.after) {
        query.where({ createdAt: { $gt: input.after as Date } });
      }
      return query;
    case GQLCOMMENT_SORT.REPLIES_DESC:
      query.orderBy({ childCount: -1, createdAt: -1 });
      if (input.after) {
        query.after(input.after as number);
      }
      return query;
    case GQLCOMMENT_SORT.REACTION_DESC:
      query.orderBy({ "actionCounts.REACTION": -1, createdAt: -1 });
      if (input.after) {
        query.after(input.after as number);
      }
      return query;
  }
}

export interface UpdateCommentStatus {
  /**
   * before is the comment before editing the status.
   */
  before: Readonly<Comment>;

  /**
   * after is the comment after editing the status.
   */
  after: Readonly<Comment>;
}

export async function updateCommentStatus(
  mongo: Db,
  tenantID: string,
  id: string,
  revisionID: string,
  status: GQLCOMMENT_STATUS
): Promise<UpdateCommentStatus | null> {
  const result = await comments(mongo).findOneAndUpdate(
    {
      id,
      tenantID,
      "revisions.id": revisionID,
    },
    {
      $set: { status },
    },
    {
      // True to return the original document instead of the updated
      // document.
      returnOriginal: true,
    }
  );
  if (!result.value) {
    return null;
  }

  return {
    before: result.value,
    after: {
      ...result.value,
      status,
    },
  };
}

/**
 * updateCommentActionCounts will update the given comment's action counts.
 *
 * @param mongo the database handle
 * @param tenantID the id of the Tenant
 * @param id the id of the Comment being updated
 * @param revisionID the id of the Comment revision being updated
 * @param actionCounts the action counts to merge into the Comment
 */
export async function updateCommentActionCounts(
  mongo: Db,
  tenantID: string,
  id: string,
  revisionID: string,
  actionCounts: EncodedCommentActionCounts
) {
  const result = await comments(mongo).findOneAndUpdate(
    { id, tenantID },
    // Update all the specific action counts that are associated with each of
    // the counts.
    {
      $inc: dotize({
        actionCounts,
        "revisions.$[revision]": { actionCounts },
      }),
    },
    {
      // Add an ArrayFilter to only update one of the OpenID Connect
      // integrations.
      arrayFilters: [{ "revision.id": revisionID }],
      // False to return the updated document instead of the original
      // document.
      returnOriginal: false,
    }
  );
  if (!result.value) {
    throw new CommentRevisionNotFoundError(id, revisionID);
  }

  return result.value;
}

/**
 * removeStoryComments will remove all comments associated with a particular
 * Story.
 */
export async function removeStoryComments(
  mongo: Db,
  tenantID: string,
  storyID: string
) {
  // Delete all the comments written on a specific story.
  return comments(mongo).deleteMany({
    tenantID,
    storyID,
  });
}

/**
 * mergeManyCommentStories will update many comment's storyID's.
 */
export async function mergeManyCommentStories(
  mongo: Db,
  tenantID: string,
  newStoryID: string,
  oldStoryIDs: string[]
) {
  return comments(mongo).updateMany(
    {
      tenantID,
      storyID: {
        $in: oldStoryIDs,
      },
    },
    {
      $set: {
        storyID: newStoryID,
      },
    }
  );
}

export async function addCommentTag(
  mongo: Db,
  tenantID: string,
  commentID: string,
  tag: CommentTag
) {
  const result = await comments(mongo).findOneAndUpdate(
    {
      tenantID,
      id: commentID,
      tags: {
        $not: {
          $eq: {
            type: tag.type,
          },
        },
      },
    },
    {
      $push: {
        tags: tag,
      },
    },
    {
      // False to return the updated document instead of the original
      // document.
      returnOriginal: false,
    }
  );
  if (!result.value) {
    const comment = await retrieveComment(mongo, tenantID, commentID);
    if (!comment) {
      throw new CommentNotFoundError(commentID);
    }

    if (comment.tags.some(({ type }) => type === tag.type)) {
      return comment;
    }

    throw new Error("could not add a tag for an unexpected reason");
  }

  return result.value;
}

export async function removeCommentTag(
  mongo: Db,
  tenantID: string,
  commentID: string,
  tagType: GQLTAG
) {
  const result = await comments(mongo).findOneAndUpdate(
    {
      tenantID,
      id: commentID,
    },
    {
      $pull: {
        tags: { type: tagType },
      },
    },
    {
      // False to return the updated document instead of the original
      // document.
      returnOriginal: false,
    }
  );
  if (!result.value) {
    const comment = await retrieveComment(mongo, tenantID, commentID);
    if (!comment) {
      throw new CommentNotFoundError(commentID);
    }

    throw new Error("could not add a tag for an unexpected reason");
  }

  return result.value;
}

export async function retrieveStoryCommentTagCounts(
  mongo: Db,
  tenantID: string,
  storyIDs: ReadonlyArray<string>
): Promise<GQLCommentTagCounts[]> {
  // Build up the $match query.
  const $match: FilterQuery<Comment> = {
    tenantID,
    // ensure we are using the tags.type index, this
    // currently includes FEATURED and UNANSWERED tags
    "tags.type": { $exists: true },
    // Only show published comment's tag counts.
    status: { $in: PUBLISHED_STATUSES },
  };
  if (storyIDs.length > 1) {
    $match.storyID = { $in: storyIDs };
  } else {
    $match.storyID = storyIDs[0];
  }

  // Get the start time.
  const timer = createTimer();

  // Load the counts from the database for this particular tag query.
  const cursor = comments<{
    _id: { tag: GQLTAG; storyID: string };
    total: number;
  }>(mongo).aggregate([
    { $match },
    { $unwind: "$tags" },
    {
      $group: {
        _id: { tag: "$tags.type", storyID: "$storyID" },
        total: { $sum: 1 },
      },
    },
  ]);

  // Get all of the counts.
  const tags = await cursor.toArray();

  // Logging at the info level here to ensure we track any degrading performance
  // issues from this query.
  logger.info({ responseTime: timer(), filter: $match }, "counting tags");

  // For each of the storyIDs...
  return storyIDs.map((storyID) => {
    // Get the tags associated with this storyID.
    const tagCounts = tags.filter(({ _id }) => _id.storyID === storyID) || [];

    // Then remap these tags to strip the storyID as the returned order already
    // preserves the storyID information.
    return tagCounts.reduce(
      (counts, { _id: { tag: code }, total }) => ({
        ...counts,
        [code]: total,
      }),
      // Keep this collection of empty tag counts up to date to ensure we
      // provide an accurate model. The type system should warn you if there is
      // missing/extra tags here.
      {
        [GQLTAG.FEATURED]: 0,
        [GQLTAG.UNANSWERED]: 0,
        [GQLTAG.REVIEW]: 0,
        [GQLTAG.QUESTION]: 0,
      }
    );
  });
}

export async function retrieveManyRecentStatusCounts(
  mongo: Db,
  tenantID: string,
  since: Date,
  authorIDs: ReadonlyArray<string>
) {
  // Get all the statuses for the given date stamp.
  const cursor = comments<{
    _id: {
      status: GQLCOMMENT_STATUS;
      authorID: string;
    };
    count: number;
  }>(mongo).aggregate([
    {
      $match: {
        tenantID,
        authorID: {
          $in: authorIDs,
        },
        createdAt: {
          $gte: since,
        },
      },
    },
    {
      $group: {
        _id: {
          status: "$status",
          authorID: "$authorID",
        },
        count: { $sum: 1 },
      },
    },
  ]);

  // Get all of the statuses.
  const docs = await cursor.toArray();

  // Iterate over the documents and join up any of the results that are
  // associated with each user.
  return authorIDs.map((authorID) => {
    // Get all the author's status counts.
    const filtered = docs.filter((doc) => doc._id.authorID === authorID);

    // Iterate over the docs to increment the status counts.
    const counts = createEmptyCommentStatusCounts();
    for (const doc of filtered) {
      counts[doc._id.status] = doc.count;
    }

    return counts;
  });
}

export async function retrieveRecentStatusCounts(
  mongo: Db,
  tenantID: string,
  since: Date,
  authorID: string
): Promise<CommentStatusCounts> {
  const counts = await retrieveManyRecentStatusCounts(mongo, tenantID, since, [
    authorID,
  ]);
  return counts[0];
}

/**
 * retrieveOngoingDiscussions will return the id's of stories where the user has
 * participated in ordered by most recent where the comment's are published.
 *
 * @param mongo the database handle
 * @param tenantID the ID of the Tenant for which to get story id's for
 * @param authorID the User's ID for the discussions we want to find
 * @param limit the maximum number of story id's we want to return.
 */
export async function retrieveOngoingDiscussions(
  mongo: Db,
  tenantID: string,
  authorID: string,
  limit: number
) {
  const timer = createTimer();

  // NOTE: (wyattjoh) this operation technically might have an issue when
  // handling users that have commented across many stories because the $sort
  // and $limit stages do not coalesce. This means that the $group phase may
  // have to collect _all_ the stories that a user has commented on (their id's
  // at least) before limiting the result. This may change on different versions
  // of MongoDB though.
  const results = await comments<{ _id: string }>(mongo)
    .aggregate([
      {
        $match: {
          tenantID,
          status: {
            $in: PUBLISHED_STATUSES,
          },
          authorID,
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$storyID",
          createdAt: { $first: "$createdAt" },
        },
      },
      { $sort: { createdAt: -1 } },
      { $limit: limit },
    ])
    .toArray();

  logger.info({ took: timer() }, "ongoing discussions query");

  return results;
}

export async function hasAuthorStoryRating(
  mongo: Db,
  tenantID: string,
  storyID: string,
  authorID: string
): Promise<boolean> {
  const timer = createTimer();

  const comment = await comments(mongo).findOne({
    tenantID,
    storyID,
    authorID,
    parentID: null,
    status: {
      $ne: GQLCOMMENT_STATUS.REJECTED,
    },
    rating: { $gt: 0 },
  });

  logger.info({ took: timer() }, "has comment rated query");

  return !!comment;
}

export async function retrieveAuthorStoryRating(
  mongo: Db,
  tenantID: string,
  storyID: string,
  authorID: string
) {
  const timer = createTimer();

  const comment = await comments<RequireProperty<Comment, "rating">>(
    mongo
  ).findOne({
    tenantID,
    storyID,
    authorID,
    parentID: null,
    status: {
      $in: [...PUBLISHED_STATUSES, GQLCOMMENT_STATUS.PREMOD],
    },
    rating: { $gt: 0 },
  });

  logger.info({ took: timer() }, "check comment rated query");

  return comment;
}

export async function retrieveStoryRatings(
  mongo: Db,
  tenantID: string,
  storyID: string
) {
  const timer = createTimer();

  const results = await comments<{
    average: number;
    count: number;
  }>(mongo)
    .aggregate([
      {
        $match: {
          tenantID,
          storyID,
          // We only store ratings on parent comments.
          parentID: null,
          // We only want to calculate an average with the comments that are
          // published.
          status: {
            $in: PUBLISHED_STATUSES,
          },
          // We only want to look at comments that contain a rating.
          rating: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          average: { $avg: "$rating" },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  // TODO: If this query becomes too expensive, we can use redis to help.
  logger.info({ took: timer() }, "story ratings query");

  if (results.length === 0) {
    return { average: 0, count: 0 };
  }

  const { average, count } = results[0];

  return { average, count };
}

export async function retrieveManyStoryRatings(
  mongo: Db,
  tenantID: string,
  storyIDs: ReadonlyArray<string>
) {
  const timer = createTimer();

  const results = await comments<{
    _id: string;
    average: number;
    count: number;
  }>(mongo)
    .aggregate([
      {
        $match: {
          tenantID,
          storyID: {
            $in: storyIDs,
          },
          // We only store ratings on parent comments.
          parentID: null,
          // We only want to calculate an average with the comments that are
          // published.
          status: {
            $in: PUBLISHED_STATUSES,
          },
          // We only want to look at comments that contain a rating.
          rating: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: "$storyID",
          average: { $avg: "$rating" },
          count: { $sum: 1 },
        },
      },
      // We could use the following if we're experiencing issues with double
      // ratings being added.
      // { $sort: { createdAt: -1 } },
      // {
      //   $group: {
      //     _id: {
      //       storyID: "$storyID",
      //       authorID: "$authorID",
      //     },
      //     rating: { $first: "$rating" },
      //   },
      // },
      // {
      //   $group: {
      //     _id: "$_id.storyID",
      //     average: { $avg: "$rating" },
      //     count: { $sum: 1 },
      //   },
      // },
    ])
    .toArray();

  // TODO: If this query becomes too expensive, we can use redis to help.
  logger.info({ took: timer() }, "multi story ratings query");

  return storyIDs.map(
    (storyID) =>
      results.find(({ _id }) => _id === storyID) || { average: 0, count: 0 }
  );
}

export async function retrieveFeaturedComments(
  mongo: Db,
  tenantID: string,
  siteID: string,
  limit: number
) {
  const $match: FilterQuery<Comment> = {
    tenantID,
    siteID,
    "tags.type": GQLTAG.FEATURED,
    status: { $in: PUBLISHED_STATUSES },
  };
  const results = await comments(mongo)
    .aggregate([
      {
        $match,
      },
      { $sort: { createdAt: -1 } },
      { $limit: limit },
    ])
    .toArray();

  return results;
}
