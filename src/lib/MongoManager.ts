/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.mongo`. Same lazy-connect / close-after-each-call lifecycle as
 * {@link SQLManager} (see `init()`/`close()`), generic over a `Document` type parameter per method
 * so callers get typed results without this class needing to know about any particular schema.
 */
import { MongoClient, Db, Document, Filter, UpdateFilter, InsertOneResult, InsertManyResult, UpdateResult, DeleteResult, WithId, OptionalUnlessRequiredId, FindOptions } from 'mongodb';
import { getEnvString } from '../core/util/getenv.js';

/**
 * @class MongoManager
 * @description MongoDB connector that manages the connection lifecycle and exposes a generic CRUD interface.
 */
export class MongoManager {
  private client!: MongoClient;
  private db!: Db;
  private connected = false;

  constructor() {}

  private async init(): Promise<void> {
    if (!this.connected) {
      const uri = getEnvString('MONGO_URI') || 'mongodb://localhost:27017';
      const dbName = getEnvString('MONGO_DATABASE') || '';

      this.client = new MongoClient(uri);
      await this.client.connect();
      this.db = this.client.db(dbName);
      this.connected = true;
    }
  }

  private async close(): Promise<void> {
    if (this.connected && this.client) {
      await this.client.close();
      this.connected = false;
    }
  }

  /**
   * @method insertOne
   * @description Inserts a document into the specified collection.
   * @param {string} collection - Collection name.
   * @param {Document} document - Document to insert.
   * @returns {Promise<InsertOneResult>} Insertion result.
   * @example
   * const result = await mongo.insertOne('users', { name: 'Ana', age: 30 });
   */
  public async insertOne<T extends Document>(collection: string, document: OptionalUnlessRequiredId<T>): Promise<InsertOneResult<T>> {
    await this.init();
    const result = await this.db.collection<T>(collection).insertOne(document);
    await this.close();
    return result;
  }

  /**
   * @method insertMany
   * @description Inserts multiple documents into the specified collection.
   * @param {string} collection - Collection name.
   * @param {Document[]} documents - Array of documents to insert.
   * @returns {Promise<InsertManyResult>} Insertion result.
   * @example
   * const result = await mongo.insertMany('users', [{ name: 'Ana' }, { name: 'Luis' }]);
   */
  public async insertMany<T extends Document>(collection: string, documents: OptionalUnlessRequiredId<T>[]): Promise<InsertManyResult<T>> {
    await this.init();
    const result = await this.db.collection<T>(collection).insertMany(documents);
    await this.close();
    return result;
  }

  /**
   * @method findOne
   * @description Finds the first document matching the filter.
   * @param {string} collection - Collection name.
   * @param {Filter<Document>} filter - Search filter.
   * @param {FindOptions} [options] - Additional options (projection, etc.).
   * @returns {Promise<WithId<T> | null>} The matching document or null.
   * @example
   * const user = await mongo.findOne('users', { name: 'Ana' });
   */
  public async findOne<T extends Document>(collection: string, filter: Filter<T>, options?: FindOptions): Promise<WithId<T> | null> {
    await this.init();
    const result = await this.db.collection<T>(collection).findOne(filter, options);
    await this.close();
    return result;
  }

  /**
   * @method find
   * @description Finds all documents matching the filter.
   * @param {string} collection - Collection name.
   * @param {Filter<Document>} filter - Search filter. Use {} to return all documents.
   * @param {FindOptions} [options] - Additional options (projection, limit, etc.).
   * @returns {Promise<WithId<T>[]>} Array of matching documents.
   * @example
   * const users = await mongo.find('users', { age: { $gte: 18 } });
   */
  public async find<T extends Document>(collection: string, filter: Filter<T>, options?: FindOptions): Promise<WithId<T>[]> {
    await this.init();
    const result = await this.db.collection<T>(collection).find(filter, options).toArray();
    await this.close();
    return result;
  }

  /**
   * @method updateOne
   * @description Updates the first document matching the filter.
   * @param {string} collection - Collection name.
   * @param {Filter<Document>} filter - Filter to identify the document.
   * @param {UpdateFilter<Document>} update - Update operation (e.g. { $set: { field: value } }).
   * @returns {Promise<UpdateResult>} Update result.
   * @example
   * const result = await mongo.updateOne('users', { name: 'Ana' }, { $set: { age: 31 } });
   */
  public async updateOne<T extends Document>(collection: string, filter: Filter<T>, update: UpdateFilter<T>): Promise<UpdateResult<T>> {
    await this.init();
    const result = await this.db.collection<T>(collection).updateOne(filter, update);
    await this.close();
    return result;
  }

  /**
   * @method updateMany
   * @description Updates all documents matching the filter.
   * @param {string} collection - Collection name.
   * @param {Filter<Document>} filter - Filter to identify the documents.
   * @param {UpdateFilter<Document>} update - Update operation.
   * @returns {Promise<UpdateResult>} Update result.
   * @example
   * const result = await mongo.updateMany('users', { active: false }, { $set: { active: true } });
   */
  public async updateMany<T extends Document>(collection: string, filter: Filter<T>, update: UpdateFilter<T>): Promise<UpdateResult<T>> {
    await this.init();
    const result = await this.db.collection<T>(collection).updateMany(filter, update);
    await this.close();
    return result;
  }

  /**
   * @method deleteOne
   * @description Deletes the first document matching the filter.
   * @param {string} collection - Collection name.
   * @param {Filter<Document>} filter - Filter to identify the document.
   * @returns {Promise<DeleteResult>} Deletion result.
   * @example
   * const result = await mongo.deleteOne('users', { name: 'Ana' });
   */
  public async deleteOne<T extends Document>(collection: string, filter: Filter<T>): Promise<DeleteResult> {
    await this.init();
    const result = await this.db.collection<T>(collection).deleteOne(filter);
    await this.close();
    return result;
  }

  /**
   * @method deleteMany
   * @description Deletes all documents matching the filter.
   * @param {string} collection - Collection name.
   * @param {Filter<Document>} filter - Filter to identify the documents.
   * @returns {Promise<DeleteResult>} Deletion result.
   * @example
   * const result = await mongo.deleteMany('users', { active: false });
   */
  public async deleteMany<T extends Document>(collection: string, filter: Filter<T>): Promise<DeleteResult> {
    await this.init();
    const result = await this.db.collection<T>(collection).deleteMany(filter);
    await this.close();
    return result;
  }
}

/**
 * @object MongoManagerTests
 * @description Test parameters to validate MongoManager functionality.
 */
export const MongoManagerTests = {
  // insertOne: { collection: 'test', document: { name: 'test_doc', value: 1 } },
  // findOne: { collection: 'test', filter: { name: 'test_doc' } },
  // find: { collection: 'test', filter: {} },
  // updateOne: { collection: 'test', filter: { name: 'test_doc' }, update: { $set: { value: 2 } } },
  // deleteOne: { collection: 'test', filter: { name: 'test_doc' } },
};
