import {PersistOperation} from "./operation/PersistOperation";
import {InsertOperation} from "./operation/InsertOperation";
import {JunctionRemoveOperation} from "./operation/JunctionRemoveOperation";
import {UpdateByRelationOperation} from "./operation/UpdateByRelationOperation";
import {UpdateByInverseSideOperation} from "./operation/UpdateByInverseSideOperation";
import {RelationMetadata} from "../metadata/RelationMetadata";
import {ObjectLiteral} from "../common/ObjectLiteral";
import {EntityMetadata} from "../metadata/EntityMetadata";
import {Connection} from "../connection/Connection";
import {QueryRunner} from "../query-runner/QueryRunner";
import {Subject} from "./subject/Subject";
import {SubjectCollection} from "./subject/SubjectCollection";
import {NewJunctionInsertOperation} from "./operation/NewJunctionInsertOperation";
import {NewJunctionRemoveOperation} from "./operation/NewJunctionRemoveOperation";

/**
 * Executes PersistOperation in the given connection.
 */
export class PersistSubjectExecutor {

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(private connection: Connection, private queryRunner: QueryRunner) {
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Executes given persist operation.
     */
    async execute(subjects: SubjectCollection, junctionInsertOperations: NewJunctionInsertOperation[], junctionRemoveOperations: NewJunctionRemoveOperation[]) {
        let isTransactionStartedByItself = false;

        const insertSubjects = subjects.filter(subject => subject.mustBeInserted);
        const updateSubjects = subjects.filter(subject => subject.mustBeUpdated);
        const removeSubjects = subjects.filter(subject => subject.mustBeRemoved);

        // validation
        // check if remove subject also must be inserted or updated - then we throw an exception
        const removeInInserts = removeSubjects.find(removeSubject => insertSubjects.indexOf(removeSubject) !== -1);
        if (removeInInserts)
            throw new Error(`Removed entity ${removeInInserts.entityTarget} is also scheduled for insert operation. This looks like ORM problem. Please report a github issue.`);

        const removeInUpdates = removeSubjects.find(removeSubject => updateSubjects.indexOf(removeSubject) !== -1);
        if (removeInUpdates)
            throw new Error(`Removed entity "${removeInUpdates.entityTarget}" is also scheduled for update operation. ` +
                `Make sure you are not updating and removing same object (note that update or remove may be executed by cascade operations).`);

        try {

            // broadcast events before we start updating
            this.connection.broadcaster.broadcastBeforeEventsForAll(insertSubjects, updateSubjects, removeSubjects);

            // open transaction if its not opened yet
            if (!this.queryRunner.isTransactionActive()) {
                isTransactionStartedByItself = true;
                await this.queryRunner.beginTransaction();
            }

            await this.executeInsertOperations(insertSubjects);
            // await this.executeInsertClosureTableOperations(insertSubjects);
            // await this.executeUpdateTreeLevelOperations(insertSubjects);
            // await this.executeInsertJunctionsOperations(junctionInsertOperations, insertSubjects);
            // await this.executeRemoveJunctionsOperations(junctionRemoveOperations);
            // await this.executeRemoveRelationOperations(persistOperation); // todo: can we add these operations into list of updated?
            // await this.executeUpdateRelationsOperations(persistOperation); // todo: merge these operations with update operations?
            // await this.executeUpdateInverseRelationsOperations(persistOperation); // todo: merge these operations with update operations?
            // await this.executeUpdateOperations(updateSubjects);
            // await this.executeRemoveOperations(removeSubjects);

            // commit transaction if it was started by us
            if (isTransactionStartedByItself === true)
                await this.queryRunner.commitTransaction();

            // update all special columns in persisted entities, like inserted id or remove ids from the removed entities
            // await this.updateSpecialColumnsInPersistedEntities(insertSubjects, updateSubjects, removeSubjects);

            // finally broadcast events
            this.connection.broadcaster.broadcastAfterEventsForAll(insertSubjects, updateSubjects, removeSubjects);

        } catch (error) {

            // rollback transaction if it was started by us
            if (isTransactionStartedByItself) {
                try {
                    await this.queryRunner.rollbackTransaction();
                } catch (secondaryError) { }
            }

            throw error;
        }
    }

    // -------------------------------------------------------------------------
    // Private Methods
    // -------------------------------------------------------------------------

    /**
     * Executes insert operations.
     */
    private async executeInsertOperations(insertSubjects: Subject[]): Promise<void> {

        // for insertion we separate two groups of entities:
        // - first group of entities are entities which does not have any relations
        //   or entities which does not have any non-nullable relation
        // - second group of entities are entities which does have non-nullable relations
        // note: these two groups should be inserted in sequence, not in parallel, because second group is depend on first

        // insert process of the entities from the first group which can only have nullable relations are actually a two-step process:
        // - first we insert entities without their relations, explicitly left them NULL
        // - later we update inserted entity once again with id of the object inserted with it
        // yes, two queries are being executed, but this is by design.
        // there is no better way to solve this problem and others at the same time.

        // insert process of the entities from the second group which can have only non nullable relations is a single-step process:
        // - we simply insert all entities and get into attention all its dependencies which were inserted in the first group

        const firstInsertSubjects = insertSubjects.filter(subject => {
            const relationsWithJoinColumns = subject.metadata.relationsWithJoinColumns;
            return relationsWithJoinColumns.length === 0 || !!relationsWithJoinColumns.find(relation => relation.isNullable);
        });
        const secondInsertSubjects = insertSubjects.filter(subject => {
            return !firstInsertSubjects.find(subjectFromFirstGroup => subjectFromFirstGroup === subject);
        });

        // console.log("firstInsertSubjects: ", firstInsertSubjects);
        // console.log("secondInsertSubjects: ", secondInsertSubjects);

        await Promise.all(firstInsertSubjects.map(subject => this.insert(subject, [])));
        await Promise.all(secondInsertSubjects.map(subject => this.insert(subject, firstInsertSubjects)));
    }

    /**
     * Executes insert operations for closure tables.
     */
    private executeInsertClosureTableOperations(insertSubjects: Subject[], updatesByRelations: Subject[]) { // todo: what to do with updatesByRelations
        const promises = insertSubjects
            .filter(subject => subject.metadata.table.isClosure)
            .map(async subject => {
                const relationsUpdateMap = this.findUpdateOperationForEntity(updatesByRelations, insertSubjects, subject.entity);
                subject.treeLevel = await this.insertIntoClosureTable(subject, relationsUpdateMap);
            });
        return Promise.all(promises);
    }

    /**
     * Executes update tree level operations in inserted entities right after data into closure table inserted.
     */
    private executeUpdateTreeLevelOperations(insertOperations: Subject[]) {
        return Promise.all(insertOperations.map(subject => this.updateTreeLevel(subject)));
    }

    /**
     * Executes insert junction operations.
     */
    private executeInsertJunctionsOperations(junctionInsertOperations: NewJunctionInsertOperation[], insertSubjects: Subject[]) {
        return Promise.all(junctionInsertOperations.map(junctionOperation => {
            return this.insertJunctions(junctionOperation, insertSubjects);
        }));
    }

    /**
     * Executes remove junction operations.
     */
    private executeRemoveJunctionsOperations(junctionRemoveOperations: NewJunctionRemoveOperation[]) {
        return Promise.all(junctionRemoveOperations.map(junctionOperation => {
            return this.removeJunctions(junctionOperation);
        }));
    }

    /**
     * Executes update relations operations.
     */
    private executeUpdateRelationsOperations(updateSubjects: Subject[], insertSubjects: Subject[]) {
        return Promise.all(updateSubjects.map(subject => {
            return this.updateByRelation(subject, insertSubjects);
        }));
    }

    /**
     * Executes update relations operations.
     */
    private executeUpdateInverseRelationsOperations(persistOperation: PersistOperation) {
        return Promise.all(persistOperation.updatesByInverseRelations.map(updateInverseOperation => {
            return this.updateInverseRelation(updateInverseOperation, persistOperation.inserts);
        }));
    }

    /**
     * Executes update operations.
     */
    private async executeUpdateOperations(updateSubjects: Subject[]): Promise<void> {
        await Promise.all(updateSubjects.map(subject => this.update(subject)));
    }

    /**
     * Executes remove relations operations.
     */
    private executeRemoveRelationOperations(removeSubjects: Subject[]) {
        return Promise.all(removeSubjects
            // .filter(operation => {
            //     return !!(operation.relation && !operation.relation.isManyToMany && !operation.relation.isOneToMany);
            // })
            .map(subject => this.updateDeletedRelations(subject))
        );
    }

    /**
     * Executes remove operations.
     */
    private executeRemoveOperations(removeSubjects: Subject[]) {
        return Promise.all(removeSubjects.map(subject => this.remove(subject)));
    }

    /**
     * Updates all special columns of the saving entities (create date, update date, versioning).
     */
    private updateSpecialColumnsInPersistedEntities(insertSubjects: Subject[], updateSubjects: Subject[], removeSubjects: Subject[]) {

        // update entity ids of the newly inserted entities
        insertSubjects.forEach(subject => {
            subject.metadata.primaryColumns.forEach(primaryColumn => {
                if (subject.entityId)
                    subject.entity[primaryColumn.propertyName] = subject.entityId[primaryColumn.propertyName];
            });
            subject.metadata.parentPrimaryColumns.forEach(primaryColumn => {
                if (subject.entityId)
                    subject.entity[primaryColumn.propertyName] = subject.entityId[primaryColumn.propertyName];
            });
        });

        insertSubjects.forEach(subject => {
            if (subject.metadata.hasUpdateDateColumn)
                subject.entity[subject.metadata.updateDateColumn.propertyName] = subject.date;
            if (subject.metadata.hasCreateDateColumn)
                subject.entity[subject.metadata.createDateColumn.propertyName] = subject.date;
            if (subject.metadata.hasVersionColumn)
                subject.entity[subject.metadata.versionColumn.propertyName]++;
            if (subject.metadata.hasTreeLevelColumn) {
                // const parentEntity = insertOperation.entity[metadata.treeParentMetadata.propertyName];
                // const parentLevel = parentEntity ? (parentEntity[metadata.treeLevelColumn.propertyName] || 0) : 0;
                subject.entity[subject.metadata.treeLevelColumn.propertyName] = subject.treeLevel;
            }
            /*if (subject.metadata.hasTreeChildrenCountColumn) {
                 subject.entity[subject.metadata.treeChildrenCountColumn.propertyName] = 0;
            }*/
        });
        updateSubjects.forEach(subject => {
            if (subject.metadata.hasUpdateDateColumn)
                subject.entity[subject.metadata.updateDateColumn.propertyName] = subject.date;
            if (subject.metadata.hasCreateDateColumn)
                subject.entity[subject.metadata.createDateColumn.propertyName] = subject.date;
            if (subject.metadata.hasVersionColumn)
                subject.entity[subject.metadata.versionColumn.propertyName]++;
        });

        // remove ids from the entities that were removed
        removeSubjects.forEach(subject => {
            // const removedEntity = removeSubjects.allPersistedEntities.find(allNewEntity => {
            //     return allNewEntity.entityTarget === subject.entityTarget && allNewEntity.compareId(subject.metadata.getEntityIdMap(subject.entity)!);
            // });
            // if (removedEntity) {
            subject.metadata.primaryColumns.forEach(primaryColumn => {
                subject.entity[primaryColumn.propertyName] = undefined;
            });
            // }
        });
    }

    private findUpdateOperationForEntity(operations: UpdateByRelationOperation[], insertSubjects: Subject[], target: any): ObjectLiteral {
        // we are using firstPrimaryColumn here because this method is used only in executeInsertClosureTableOperations method
        // which means only for tree tables, but multiple primary keys are not supported in tree tables

        let updateMap: ObjectLiteral = {};
        operations
            .forEach(operation => { // duplication with updateByRelation method
                const metadata = this.connection.entityMetadatas.findByTarget(operation.insertOperation.target);
                const relatedInsertOperation = insertSubjects.find(o => o.entity === operation.targetEntity);

                // todo: looks like first primary column should not be used there for two reasons:
                // 1. there can be multiple primary columns, which one is mapped in the relation
                // 2. parent primary column
                // join column should be used instead

                if (operation.updatedRelation.isOneToMany) {
                    const idInInserts = relatedInsertOperation && relatedInsertOperation.entityId ? relatedInsertOperation.entityId[metadata.firstPrimaryColumn.propertyName] : null;
                    if (operation.insertOperation.entity === target)
                        updateMap[operation.updatedRelation.inverseRelation.propertyName] = operation.targetEntity[metadata.firstPrimaryColumn.propertyName] || idInInserts;

                } else {
                    if (operation.targetEntity === target && operation.insertOperation.entityId)
                        updateMap[operation.updatedRelation.propertyName] = operation.insertOperation.entityId[metadata.firstPrimaryColumn.propertyName];
                }
            });

        return updateMap;
    }

    private updateByRelation(operation: UpdateByRelationOperation, insertOperations: InsertOperation[]) {
        if (!operation.insertOperation.entityId)
            throw new Error(`insert operation does not have entity id`);

        let tableName: string, relationName: string, relationId: ObjectLiteral, idColumn: string, id: any, updateMap: ObjectLiteral|undefined;
        const relatedInsertOperation = insertOperations.find(o => o.entity === operation.targetEntity);

        if (operation.updatedRelation.isOneToMany || operation.updatedRelation.isOneToOneNotOwner) {
            const metadata = this.connection.entityMetadatas.findByTarget(operation.insertOperation.target);
            const idInInserts = relatedInsertOperation && relatedInsertOperation.entityId ? relatedInsertOperation.entityId[metadata.firstPrimaryColumn.propertyName] : null; // todo: use join column instead of primary column here
            tableName = metadata.table.name;
            relationName = operation.updatedRelation.inverseRelation.name;
            relationId = operation.targetEntity[metadata.firstPrimaryColumn.propertyName] || idInInserts; // todo: make sure idInInserts is always a map
            
            updateMap = metadata.transformIdMapToColumnNames(operation.insertOperation.entityId);
        } else {
            const metadata = this.connection.entityMetadatas.findByTarget(operation.entityTarget);
            let idInInserts: ObjectLiteral|undefined = undefined;
            if (relatedInsertOperation && relatedInsertOperation.entityId) {
                idInInserts = { [metadata.firstPrimaryColumn.propertyName]: relatedInsertOperation.entityId[metadata.firstPrimaryColumn.propertyName] };
            } // todo: use join column instead of primary column here
            tableName = metadata.table.name;
            relationName = operation.updatedRelation.name;
            relationId = operation.insertOperation.entityId[metadata.firstPrimaryColumn.propertyName]; // todo: make sure entityId is always a map
            // idColumn = metadata.primaryColumn.name;
            // id = operation.targetEntity[metadata.primaryColumn.propertyName] || idInInserts;
            updateMap = metadata.getEntityIdColumnMap(operation.targetEntity) || idInInserts; // todo: make sure idInInserts always object even when id is single!!!
        }
        if (!updateMap)
            throw new Error(`Cannot execute update by relation operation, because cannot find update criteria`);

        return this.queryRunner.update(tableName, { [relationName]: relationId }, updateMap);
    }

    private updateInverseRelation(operation: UpdateByInverseSideOperation, insertOperations: InsertOperation[]) {
        const targetEntityMetadata = this.connection.entityMetadatas.findByTarget(operation.entityTarget);
        const fromEntityMetadata = this.connection.entityMetadatas.findByTarget(operation.fromEntityTarget);
        const tableName = targetEntityMetadata.table.name;
        const targetRelation = operation.fromRelation.inverseRelation;
        const updateMap = targetEntityMetadata.getEntityIdColumnMap(operation.targetEntity);
        if (!updateMap) return; // todo: is return correct here?

        const fromEntityInsertOperation = insertOperations.find(o => o.entity === operation.fromEntity);
        let targetEntityId: any; // todo: better do it during insertion - pass UpdateByInverseSideOperation[] to insert and do it there
        if (operation.operationType === "remove") {
            targetEntityId = null;
        } else {
            if (fromEntityInsertOperation && fromEntityInsertOperation.entityId && targetRelation.joinColumn.referencedColumn === fromEntityMetadata.firstPrimaryColumn) {
                targetEntityId = fromEntityInsertOperation.entityId[fromEntityMetadata.firstPrimaryColumn.name];
            } else {
                targetEntityId = operation.fromEntity[targetRelation.joinColumn.referencedColumn.name];
            }
        }

        return this.queryRunner.update(tableName, { [targetRelation.name]: targetEntityId }, updateMap);
    }

    private async update(subject: Subject): Promise<void> {
        const entity = subject.entity;

        // we group by table name, because metadata can have different table names
        const valueMaps: { tableName: string, metadata: EntityMetadata, values: ObjectLiteral }[] = [];

        subject.diffColumns.forEach(column => {
            if (!column.entityTarget) return;
            const metadata = this.connection.entityMetadatas.findByTarget(column.entityTarget);
            let valueMap = valueMaps.find(valueMap => valueMap.tableName === metadata.table.name);
            if (!valueMap) {
                valueMap = { tableName: metadata.table.name, metadata: metadata, values: {} };
                valueMaps.push(valueMap);
            }

            valueMap.values[column.name] = this.connection.driver.preparePersistentValue(column.getEntityValue(entity), column);
        });

        subject.diffRelations.forEach(relation => {
            const metadata = this.connection.entityMetadatas.findByTarget(relation.entityTarget);
            let valueMap = valueMaps.find(valueMap => valueMap.tableName === metadata.table.name);
            if (!valueMap) {
                valueMap = { tableName: metadata.table.name, metadata: metadata, values: {} };
                valueMaps.push(valueMap);
            }

            const value = this.getEntityRelationValue(relation, entity);
            valueMap.values[relation.name] = value !== null && value !== undefined ? value[relation.inverseEntityMetadata.firstPrimaryColumn.propertyName] : null; // todo: should not have a call to primaryColumn, instead join column metadata should be used
        });

        // if number of updated columns = 0 no need to update updated date and version columns
        if (Object.keys(valueMaps).length === 0)
            return;

        if (subject.metadata.hasUpdateDateColumn) {
            let valueMap = valueMaps.find(valueMap => valueMap.tableName === subject.metadata.table.name);
            if (!valueMap) {
                valueMap = { tableName: subject.metadata.table.name, metadata: subject.metadata, values: {} };
                valueMaps.push(valueMap);
            }

            valueMap.values[subject.metadata.updateDateColumn.name] = this.connection.driver.preparePersistentValue(new Date(), subject.metadata.updateDateColumn);
        }

        if (subject.metadata.hasVersionColumn) {
            let valueMap = valueMaps.find(valueMap => valueMap.tableName === subject.metadata.table.name);
            if (!valueMap) {
                valueMap = { tableName: subject.metadata.table.name, metadata: subject.metadata, values: {} };
                valueMaps.push(valueMap);
            }

            valueMap.values[subject.metadata.versionColumn.name] = this.connection.driver.preparePersistentValue(entity[subject.metadata.versionColumn.propertyName] + 1, metadata.versionColumn);
        }

        if (subject.metadata.parentEntityMetadata) {
            if (subject.metadata.parentEntityMetadata.hasUpdateDateColumn) {
                let valueMap = valueMaps.find(valueMap => valueMap.tableName === subject.metadata.parentEntityMetadata.table.name);
                if (!valueMap) {
                    valueMap = { tableName: subject.metadata.parentEntityMetadata.table.name, metadata: subject.metadata.parentEntityMetadata, values: {} };
                    valueMaps.push(valueMap);
                }

                valueMap.values[subject.metadata.parentEntityMetadata.updateDateColumn.name] = this.connection.driver.preparePersistentValue(new Date(), subject.metadata.parentEntityMetadata.updateDateColumn);
            }

            if (subject.metadata.parentEntityMetadata.hasVersionColumn) {
                let valueMap = valueMaps.find(valueMap => valueMap.tableName === subject.metadata.parentEntityMetadata.table.name);
                if (!valueMap) {
                    valueMap = { tableName: subject.metadata.parentEntityMetadata.table.name, metadata: subject.metadata.parentEntityMetadata, values: {} };
                    valueMaps.push(valueMap);
                }

                valueMap.values[subject.metadata.parentEntityMetadata.versionColumn.name] = this.connection.driver.preparePersistentValue(entity[subject.metadata.parentEntityMetadata.versionColumn.propertyName] + 1, subject.metadata.parentEntityMetadata.versionColumn);
            }
        }

        await Promise.all(valueMaps.map(valueMap => {
            const conditions: ObjectLiteral = {};
            if (valueMap.metadata.parentEntityMetadata && valueMap.metadata.parentEntityMetadata.inheritanceType === "class-table") { // valueMap.metadata.getEntityIdMap(entity)!
                valueMap.metadata.parentIdColumns.forEach(column => {
                    conditions[column.name] = entity[column.propertyName];
                });

            } else {
                valueMap.metadata.primaryColumns.forEach(column => {
                    conditions[column.name] = entity[column.propertyName];
                });
            }
            return this.queryRunner.update(valueMap.tableName, valueMap.values, conditions);
        }));
    }

    private updateDeletedRelations(subject: Subject) { // todo: check if both many-to-one deletions work too
        if (!subject.fromEntityId)
            throw new Error(`remove operation does not have entity id`);

        if (removeOperation.relation) {
            return this.queryRunner.update(
                removeOperation.fromMetadata.table.name,
                { [removeOperation.relation.name]: null },
                removeOperation.fromEntityId
            );
        }

        throw new Error("Remove operation relation is not set"); // todo: find out how its possible
    }

    private async remove(subject: Subject): Promise<void> {
        if (subject.metadata.parentEntityMetadata) {
            const parentConditions: ObjectLiteral = {};
            subject.metadata.parentPrimaryColumns.forEach(column => {
                parentConditions[column.name] = subject.entity[column.propertyName];
            });
            await this.queryRunner.delete(subject.metadata.parentEntityMetadata.table.name, parentConditions);

            const childConditions: ObjectLiteral = {};
            subject.metadata.primaryColumnsWithParentIdColumns.forEach(column => {
                childConditions[column.name] = subject.entity[column.propertyName];
            });
            await this.queryRunner.delete(subject.metadata.table.name, childConditions);
        } else {
            await this.queryRunner.delete(subject.metadata.table.name, subject.metadata.getEntityIdColumnMap(subject.entity)!);
        }
    }

    /**
     * Inserts an entity from the given insert operation into the database.
     * If entity has an generated column, then after saving new generated value will be stored to the InsertOperation.
     * If entity uses class-table-inheritance, then multiple inserts may by performed to save all entities.
     */
    private async insert(subject: Subject, alreadyInsertedSubjects: Subject[]): Promise<any> {

        const parentEntityMetadata = subject.metadata.parentEntityMetadata;
        const metadata = subject.metadata;
        const entity = subject.entity;

        // if entity uses class table inheritance then we need to separate entity into sub values that will be inserted into multiple tables
        if (metadata.table.isClassTableChild) { // todo: with current implementation inheritance of multiple class table children will not work

            // first insert entity values into parent class table
            const parentValuesMap = this.collectColumnsAndValues(parentEntityMetadata, entity, subject.date, undefined, metadata.discriminatorValue, alreadyInsertedSubjects);
            subject.newlyGeneratedId = await this.queryRunner.insert(parentEntityMetadata.table.name, parentValuesMap, parentEntityMetadata.generatedColumnIfExist);

            // second insert entity values into child class table
            const childValuesMap = this.collectColumnsAndValues(metadata, entity, subject.date, subject.newlyGeneratedId, undefined, alreadyInsertedSubjects);
            const secondGeneratedId = await this.queryRunner.insert(metadata.table.name, childValuesMap, metadata.generatedColumnIfExist);
            if (!subject.newlyGeneratedId && secondGeneratedId) subject.newlyGeneratedId = secondGeneratedId;

        } else { // in the case when class table inheritance is not used
            const valuesMap = this.collectColumnsAndValues(metadata, entity, subject.date, undefined, undefined, alreadyInsertedSubjects);
            subject.newlyGeneratedId = await this.queryRunner.insert(metadata.table.name, valuesMap, metadata.generatedColumnIfExist);
        }

        // todo: remove this block once usage of subject.entityId are removed
        // if there is a generated column and we have a generated id then store it in the insert operation for further use
        if (parentEntityMetadata && parentEntityMetadata.hasGeneratedColumn && subject.newlyGeneratedId) {
            subject.entityId = { [parentEntityMetadata.generatedColumn.propertyName]: subject.newlyGeneratedId };

        } else if (metadata.hasGeneratedColumn && subject.newlyGeneratedId) {
            subject.entityId = { [metadata.generatedColumn.propertyName]: subject.newlyGeneratedId };
        }

    }

    private collectColumnsAndValues(metadata: EntityMetadata, entity: any, date: Date, parentIdColumnValue: any, discriminatorValue: any, alreadyInsertedSubjects: Subject[]): ObjectLiteral {

        // extract all columns
        const columns = metadata.columns.filter(column => {
            return !column.isVirtual && !column.isParentId && !column.isDiscriminator && column.hasEntityValue(entity);
        });

        const relationColumns = metadata.relationsWithJoinColumns
            .filter(relation => entity.hasOwnProperty(relation.propertyName));

        const columnNames = columns.map(column => column.name);
        const relationColumnNames = relationColumns.map(relation => relation.name);
        const allColumnNames = columnNames.concat(relationColumnNames);

        const columnValues = columns.map(column => {
            return this.connection.driver.preparePersistentValue(column.getEntityValue(entity), column);
        });

        // extract all values
        const relationValues = relationColumns.map(relation => {
            const value = relation.getEntityValue(entity);
            if (value === null || value === undefined)
                return value;

            // if relation value is stored in the entity itself then use it from there
            const relationId = relation.getInverseEntityRelationId(value); // todo: check it
            if (relationId)
                return relationId;

            // otherwise try to find relational value from just inserted subjects
            const alreadyInsertedSubject = alreadyInsertedSubjects.find(insertedSubject => {
                return insertedSubject.entity === value;
            });
            if (alreadyInsertedSubject) {
                const referencedColumn = relation.joinColumn.referencedColumn;

                // if join column references to the primary generated column then seek in the newEntityId of the insertedSubject
                if (referencedColumn.isGenerated)
                    return alreadyInsertedSubject.newlyGeneratedId;

                // if it references to create or update date columns
                if (referencedColumn.isCreateDate || referencedColumn.isUpdateDate)
                    return this.connection.driver.preparePersistentValue(alreadyInsertedSubject.date, referencedColumn);

                // if it references to version column
                if (referencedColumn.isVersion)
                    return this.connection.driver.preparePersistentValue(1, referencedColumn);

                // todo: implement other referenced column types
            }
        });

        const allValues = columnValues.concat(relationValues);

        // add special column and value - date of creation
        if (metadata.hasCreateDateColumn) {
            allColumnNames.push(metadata.createDateColumn.name);
            allValues.push(this.connection.driver.preparePersistentValue(date, metadata.createDateColumn));
        }

        // add special column and value - date of updating
        if (metadata.hasUpdateDateColumn) {
            allColumnNames.push(metadata.updateDateColumn.name);
            allValues.push(this.connection.driver.preparePersistentValue(date, metadata.updateDateColumn));
        }

        // add special column and value - version column
        if (metadata.hasVersionColumn) {
            allColumnNames.push(metadata.versionColumn.name);
            allValues.push(this.connection.driver.preparePersistentValue(1, metadata.versionColumn));
        }

        // add special column and value - discriminator value (for tables using table inheritance)
        if (metadata.hasDiscriminatorColumn) {
            allColumnNames.push(metadata.discriminatorColumn.name);
            allValues.push(this.connection.driver.preparePersistentValue(discriminatorValue || metadata.discriminatorValue, metadata.discriminatorColumn));
        }

        // add special column and value - tree level and tree parents (for tree-type tables)
        if (metadata.hasTreeLevelColumn && metadata.hasTreeParentRelation) {
            const parentEntity = entity[metadata.treeParentRelation.propertyName];
            const parentLevel = parentEntity ? (parentEntity[metadata.treeLevelColumn.propertyName] || 0) : 0;

            allColumnNames.push(metadata.treeLevelColumn.name);
            allValues.push(parentLevel + 1);
        }

        // add special column and value - parent id column (for tables using table inheritance)
        if (metadata.parentEntityMetadata && metadata.hasParentIdColumn) {
            allColumnNames.push(metadata.parentIdColumn.name); // todo: should be array of primary keys
            allValues.push(parentIdColumnValue || entity[metadata.parentEntityMetadata.firstPrimaryColumn.propertyName]); // todo: should be array of primary keys
        }

        return this.zipObject(allColumnNames, allValues);
    }

    private insertIntoClosureTable(subject: Subject, updateMap: ObjectLiteral) {
        // here we can only support to work only with single primary key entities

        const entity = subject.entity;
        const metadata = this.connection.entityMetadatas.findByTarget(subject.entityTarget);
        const parentEntity = entity[metadata.treeParentRelation.propertyName];

        let parentEntityId: any = 0;
        if (parentEntity && parentEntity[metadata.firstPrimaryColumn.propertyName]) {
            parentEntityId = parentEntity[metadata.firstPrimaryColumn.propertyName];

        } else if (updateMap && updateMap[metadata.treeParentRelation.propertyName]) { // todo: name or propertyName: depend how update will be implemented. or even find relation of this treeParent and use its name?
            parentEntityId = updateMap[metadata.treeParentRelation.propertyName];
        }

        if (!subject.entityId)
            throw new Error(`operation does not have entity id`);
        // todo: this code does not take in count a primary column from the parent entity metadata
        return this.queryRunner.insertIntoClosureTable(metadata.closureJunctionTable.table.name, subject.entityId[metadata.firstPrimaryColumn.propertyName], parentEntityId, metadata.hasTreeLevelColumn)
            /*.then(() => {
                // we also need to update children count in parent
                if (parentEntity && parentEntityId) {
                    const values = { [metadata.treeChildrenCountColumn.name]: parentEntity[metadata.treeChildrenCountColumn.name] + 1 };
                    return this.connection.driver.update(metadata.table.name, values, { [metadata.primaryColumn.name]: parentEntityId });
                }
                return;
            })*/;
    }

    private async updateTreeLevel(subject: Subject): Promise<void> {
        if (subject.metadata.hasTreeLevelColumn && subject.treeLevel) {
            if (!subject.entityId)
                throw new Error(`remove operation does not have entity id`);

            const values = { [subject.metadata.treeLevelColumn.name]: subject.treeLevel };
            await this.queryRunner.update(subject.metadata.table.name, values, subject.entityId);
        }
    }

    private insertJunctions(junctionOperation: NewJunctionInsertOperation, insertOperations: Subject[]) {
        // I think here we can only support to work only with single primary key entities

        const metadata1 = this.connection.entityMetadatas.findByTarget(junctionOperation.entity1Target);
        const metadata2 = this.connection.entityMetadatas.findByTarget(junctionOperation.entity2Target);
        const columns = junctionOperation.metadata.columns.map(column => column.name);
        const insertOperation1 = insertOperations.find(o => o.entity === junctionOperation.entity1);
        const insertOperation2 = insertOperations.find(o => o.entity === junctionOperation.entity2);

        // todo: firstPrimaryColumn should not be used there! use join column's properties instead!

        let id1 = junctionOperation.entity1[metadata1.firstPrimaryColumn.propertyName];
        let id2 = junctionOperation.entity2[metadata2.firstPrimaryColumn.propertyName];
        
        if (!id1) {
            if (insertOperation1 && insertOperation1.entityId) {
                id1 = insertOperation1.entityId[metadata1.firstPrimaryColumn.propertyName];
            } else {
                throw new Error(`Cannot insert object of ${junctionOperation.entity1.constructor.name} type. Looks like its not persisted yet, or cascades are not set on the relation.`);
            }
        } 
        
        if (!id2) {
            if (insertOperation2 && insertOperation2.entityId) {
                id2 = insertOperation2.entityId[metadata2.firstPrimaryColumn.propertyName];
            } else {
                throw new Error(`Cannot insert object of ${junctionOperation.entity2.constructor.name} type. Looks like its not persisted yet, or cascades are not set on the relation.`);
            }
        }
        
        let values: any[]; 
        // order may differ, find solution (column.table to compare with entity metadata table?)
        if (metadata1.table === junctionMetadata.foreignKeys[0].referencedTable) {
            values = [id1, id2];
        } else {
            values = [id2, id1];
        }
        
        return this.queryRunner.insert(junctionMetadata.table.name, this.zipObject(columns, values));
    }

    private removeJunctions(junctionOperation: JunctionRemoveOperation) {
        // I think here we can only support to work only with single primary key entities
        const junctionMetadata = junctionOperation.metadata;
        const metadata1 = this.connection.entityMetadatas.findByTarget(junctionOperation.entity1Target);
        const metadata2 = this.connection.entityMetadatas.findByTarget(junctionOperation.entity2Target);
        const columns = junctionMetadata.columns.map(column => column.name);
        const id1 = junctionOperation.entity1[metadata1.firstPrimaryColumn.propertyName];
        const id2 = junctionOperation.entity2[metadata2.firstPrimaryColumn.propertyName];
        return this.queryRunner.delete(junctionMetadata.table.name, { [columns[0]]: id1, [columns[1]]: id2 });
    }

    private zipObject(keys: any[], values: any[]): Object {
        return keys.reduce((object, column, index) => {
            (<any> object)[column] = values[index];
            return object;
        }, {});
    }

    private getEntityRelationValue(relation: RelationMetadata, entity: any) {
        return relation.isLazy ? entity["__" + relation.propertyName + "__"] : entity[relation.propertyName];
    }

}