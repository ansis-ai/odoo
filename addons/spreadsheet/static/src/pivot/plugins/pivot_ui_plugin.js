/** @odoo-module */

import * as spreadsheet from "@odoo/o-spreadsheet";
import { getFirstPivotFunction, getNumberOfPivotFormulas } from "../pivot_helpers";
import { FILTER_DATE_OPTION, monthsOptions } from "@spreadsheet/assets_backend/constants";
import { Domain } from "@web/core/domain";
import { NO_RECORD_AT_THIS_POSITION } from "../pivot_model";
import { globalFiltersFieldMatchers } from "@spreadsheet/global_filters/plugins/global_filters_core_plugin";
import { PivotDataSource } from "../pivot_data_source";
import { OdooUIPlugin } from "@spreadsheet/plugins";
import { pivotTimeAdapter } from "../pivot_time_adapters";

const { astToFormula, helpers } = spreadsheet;
const { formatValue } = helpers;
const { DateTime } = luxon;

/**
 * @typedef {import("./pivot_core_plugin").PivotDefinition} PivotDefinition
 * @typedef {import("@spreadsheet/global_filters/plugins/global_filters_core_plugin").FieldMatching} FieldMatching
 * @typedef {import("@spreadsheet/helpers/odoo_functions_helpers").Token} Token
 */

/**
 * Convert pivot period to the related filter value
 *
 * @param {import("@spreadsheet/global_filters/plugins/global_filters_core_plugin").RangeType} timeRange
 * @param {string} value
 * @returns {object}
 */
function pivotPeriodToFilterValue(timeRange, value) {
    // reuse the same logic as in `parseAccountingDate`?
    const yearOffset = (value.split("/").pop() | 0) - DateTime.now().year;
    switch (timeRange) {
        case "year":
            return {
                yearOffset,
            };
        case "month": {
            const month = value.split("/")[0] | 0;
            return {
                yearOffset,
                period: monthsOptions[month - 1].id,
            };
        }
        case "quarter": {
            const quarter = value.split("/")[0] | 0;
            return {
                yearOffset,
                period: FILTER_DATE_OPTION.quarter[quarter - 1],
            };
        }
    }
}

export class PivotUIPlugin extends OdooUIPlugin {
    static getters = /** @type {const} */ ([
        "getPivotDataSource",
        "getAsyncPivotDataSource",
        "getFirstPivotFunction",
        "getPivotComputedDomain",
        "computeOdooPivotHeaderValue",
        "getPivotHeaderFormattedValue",
        "getPivotFieldFormat",
        "getPivotIdFromPosition",
        "getPivotCellValue",
        "getPivotGroupByValues",
        "getFiltersMatchingPivotArgs",
        "getPivotDataSourceId",
        "getPivotTableStructure",
        "getPivotDomainArgsFromPosition",
        "isPivotUnused",
    ]);
    constructor(config) {
        super(config);
        /** @type {string} */
        this.selection.observe(this, {
            handleEvent: this.handleEvent.bind(this),
        });

        this.dataSources = config.custom.dataSources;

        globalFiltersFieldMatchers["pivot"] = {
            ...globalFiltersFieldMatchers["pivot"],
            waitForReady: () => this._getPivotsWaitForReady(),
            getFields: (pivotId) => this.getPivotDataSource(pivotId).getFields(),
        };
    }

    handleEvent(event) {
        if (!this.getters.isDashboard()) {
            return;
        }
        switch (event.type) {
            case "ZonesSelected": {
                const sheetId = this.getters.getActiveSheetId();
                const { col, row } = event.anchor.cell;
                const cell = this.getters.getCell({ sheetId, col, row });
                if (cell !== undefined && cell.content.startsWith("=ODOO.PIVOT.HEADER(")) {
                    const filters = this._getFiltersMatchingPivot(cell.compiledFormula.tokens);
                    this.dispatch("SET_MANY_GLOBAL_FILTER_VALUE", { filters });
                }
                break;
            }
        }
    }

    beforeHandle(cmd) {
        switch (cmd.type) {
            case "START":
                for (const pivotId of this.getters.getPivotIds()) {
                    this._setupPivotDataSource(pivotId);
                }

                // make sure the domains are correctly set before
                // any evaluation
                this._addDomains();
                break;
        }
    }

    /**
     * Handle a spreadsheet command
     * @param {Object} cmd Command
     */
    handle(cmd) {
        switch (cmd.type) {
            case "REFRESH_PIVOT":
                this._refreshOdooPivot(cmd.id);
                break;
            case "REFRESH_ALL_DATA_SOURCES":
                this._refreshOdooPivots();
                break;
            case "ADD_GLOBAL_FILTER":
            case "EDIT_GLOBAL_FILTER":
            case "REMOVE_GLOBAL_FILTER":
            case "SET_GLOBAL_FILTER_VALUE":
            case "CLEAR_GLOBAL_FILTER_VALUE":
                this._addDomains();
                break;
            case "INSERT_PIVOT": {
                const { id } = cmd;
                this._setupPivotDataSource(id);
                break;
            }
            case "DUPLICATE_PIVOT": {
                const { newPivotId } = cmd;
                this._setupPivotDataSource(newPivotId);
                break;
            }
            case "UPDATE_ODOO_PIVOT_DOMAIN": {
                const pivotDefinition = this._getPivotDefinitionForDataSource(cmd.pivotId);
                const dataSourceId = this.getPivotDataSourceId(cmd.pivotId);
                this.dataSources.add(dataSourceId, PivotDataSource, pivotDefinition);
                break;
            }
            case "DELETE_SHEET":
            case "UPDATE_CELL": {
                this.unusedPivots = undefined;
                break;
            }
            case "UNDO":
            case "REDO": {
                this.unusedPivots = undefined;
                if (
                    cmd.commands.find((command) =>
                        [
                            "ADD_GLOBAL_FILTER",
                            "EDIT_GLOBAL_FILTER",
                            "REMOVE_GLOBAL_FILTER",
                        ].includes(command.type)
                    )
                ) {
                    this._addDomains();
                }

                const domainEditionCommands = cmd.commands.filter(
                    (cmd) => cmd.type === "UPDATE_ODOO_PIVOT_DOMAIN" || cmd.type === "INSERT_PIVOT"
                );
                for (const cmd of domainEditionCommands) {
                    if (!this.getters.isExistingPivot(cmd.pivotId)) {
                        continue;
                    }

                    const pivotDefinition = this._getPivotDefinitionForDataSource(cmd.pivotId);
                    const dataSourceId = this.getPivotDataSourceId(cmd.pivotId);
                    this.dataSources.add(dataSourceId, PivotDataSource, pivotDefinition);
                }
                break;
            }
        }
    }

    // ---------------------------------------------------------------------
    // Getters
    // ---------------------------------------------------------------------

    /**
     * Get the id of the pivot at the given position. Returns undefined if there
     * is no pivot at this position
     *
     * @param {{ sheetId: string; col: number; row: number}} position
     *
     * @returns {string|undefined}
     */
    getPivotIdFromPosition(position) {
        const cell = this.getters.getCorrespondingFormulaCell(position);
        if (cell && cell.isFormula) {
            const pivotFunction = this.getters.getFirstPivotFunction(cell.compiledFormula.tokens);
            if (pivotFunction) {
                return pivotFunction.args[0]?.toString();
            }
        }
        return undefined;
    }

    getFirstPivotFunction(tokens) {
        const pivotFunction = getFirstPivotFunction(tokens);
        if (!pivotFunction) {
            return undefined;
        }
        const { functionName, args } = pivotFunction;
        const evaluatedArgs = args.map((argAst) => {
            if (argAst.type == "EMPTY") {
                return undefined;
            } else if (
                argAst.type === "STRING" ||
                argAst.type === "BOOLEAN" ||
                argAst.type === "NUMBER"
            ) {
                return argAst.value;
            }
            const argsString = astToFormula(argAst);
            return this.getters.evaluateFormula(this.getters.getActiveSheetId(), argsString);
        });
        return { functionName, args: evaluatedArgs };
    }

    /**
     * Returns the domain args of a pivot formula from a position.
     * For all those formulas:
     *
     * =ODOO.PIVOT(1,"expected_revenue","stage_id",2,"city","Brussels")
     * =ODOO.PIVOT.HEADER(1,"stage_id",2,"city","Brussels")
     * =ODOO.PIVOT.HEADER(1,"stage_id",2,"city","Brussels","measure","expected_revenue")
     *
     * the result is the same: ["stage_id", 2, "city", "Brussels"]
     *
     * If the cell is the result of ODOO.PIVOT.TABLE, the result is the domain of the cell
     * as if it was the individual pivot formula
     *
     * @param {{ col: number, row: number, sheetId: string }} position
     * @returns {(string | number)[] | undefined}
     */
    getPivotDomainArgsFromPosition(position) {
        const cell = this.getters.getCorrespondingFormulaCell(position);
        if (
            !cell ||
            !cell.isFormula ||
            getNumberOfPivotFormulas(cell.compiledFormula.tokens) === 0
        ) {
            return undefined;
        }
        const mainPosition = this.getters.getCellPosition(cell.id);
        const { args, functionName } = this.getters.getFirstPivotFunction(
            cell.compiledFormula.tokens
        );
        if (functionName === "ODOO.PIVOT.TABLE") {
            const pivotId = args[0];
            const dataSource = this.getPivotDataSource(pivotId);
            if (!this.getters.isExistingPivot(pivotId) || !dataSource.isReady()) {
                return undefined;
            }
            const includeTotal = args[2];
            const includeColumnHeaders = args[3];
            const pivotCells = this.getPivotTableStructure(pivotId).getPivotCells(
                includeTotal,
                includeColumnHeaders
            );
            const pivotCol = position.col - mainPosition.col;
            const pivotRow = position.row - mainPosition.row;
            const pivotCell = pivotCells[pivotCol][pivotRow];
            const domain = pivotCell.domain;
            if (domain?.at(-2) === "measure") {
                return domain.slice(0, -2);
            }
            return domain;
        }
        const domain = args.slice(functionName === "ODOO.PIVOT" ? 2 : 1);
        if (domain.at(-2) === "measure") {
            return domain.slice(0, -2);
        }
        return domain;
    }

    /**
     * Get the computed domain of a pivot
     * CLEAN ME not used outside of tests
     * @param {string} pivotId Id of the pivot
     * @returns {Array}
     */
    getPivotComputedDomain(pivotId) {
        return this.getters.getPivotDataSource(pivotId).getComputedDomain();
    }

    /**
     * Return all possible values in the pivot for a given field.
     *
     * @param {string} pivotId Id of the pivot
     * @param {string} fieldName
     * @returns {Array<string>}
     */
    getPivotGroupByValues(pivotId, fieldName) {
        return this.getters.getPivotDataSource(pivotId).getPossibleValuesForGroupBy(fieldName);
    }

    /**
     * High level method computing the result of ODOO.PIVOT.HEADER functions.
     *
     * @param {string} pivotId Id of a pivot
     * @param {(string | number)[]} domainArgs arguments of the function (except the first one which is the pivot id)
     */
    computeOdooPivotHeaderValue(pivotId, domainArgs) {
        const dataSource = this.getters.getPivotDataSource(pivotId);
        dataSource.markAsHeaderUsed(domainArgs);
        return dataSource.computeOdooPivotHeaderValue(domainArgs);
    }

    /**
     * High level method computing the formatted result of ODOO.PIVOT.HEADER functions.
     *
     * @param {string} pivotId
     * @param {(string | number)[]} pivotArgs arguments of the function (except the first one which is the pivot id)
     */
    getPivotHeaderFormattedValue(pivotId, pivotArgs) {
        const dataSource = this.getters.getPivotDataSource(pivotId);
        const value = dataSource.computeOdooPivotHeaderValue(pivotArgs);
        if (typeof value === "string") {
            return value;
        }
        const format = this.getPivotFieldFormat(pivotId, pivotArgs.at(-2));
        const locale = this.getters.getLocale();
        return formatValue(value, { format, locale });
    }

    getPivotFieldFormat(pivotId, fieldName) {
        const dataSource = this.getPivotDataSource(pivotId);
        const { field, aggregateOperator } = dataSource.parseGroupField(fieldName);
        return this._getFieldFormat(field, aggregateOperator);
    }

    /**
     * Get the value for a pivot cell
     *
     * @param {string} pivotId Id of a pivot
     * @param {string} measure Field name of the measures
     * @param {Array<string>} domain Domain
     *
     * @returns {string|number|undefined}
     */
    getPivotCellValue(pivotId, measure, domain) {
        const dataSource = this.getters.getPivotDataSource(pivotId);
        dataSource.markAsValueUsed(domain, measure);
        return dataSource.getPivotCellValue(measure, domain);
    }

    getPivotTableStructure(pivotId) {
        const dataSource = this.getters.getPivotDataSource(pivotId);
        return dataSource.getTableStructure();
    }

    /**
     * Get the filter impacted by a pivot formula's argument
     * @param {Token[]} tokens Formula of the pivot cell
     *
     * @returns {Array<Object>}
     */
    _getFiltersMatchingPivot(tokens) {
        const functionDescription = this.getters.getFirstPivotFunction(tokens);
        if (!functionDescription) {
            return [];
        }
        const { args } = functionDescription;
        if (args.length <= 2) {
            return [];
        }
        const pivotId = args[0];
        return this.getFiltersMatchingPivotArgs(pivotId, args);
    }

    /**
     * Get the filter impacted by a pivot
     */
    getFiltersMatchingPivotArgs(pivotId, domainArgs) {
        const argField = domainArgs[domainArgs.length - 2];
        if (argField === "measure" || !argField) {
            return [];
        }
        const filters = this.getters.getGlobalFilters();
        const matchingFilters = [];

        for (const filter of filters) {
            const dataSource = this.getters.getPivotDataSource(pivotId);
            const { field, aggregateOperator: time } = dataSource.parseGroupField(argField);
            const pivotFieldMatching = this.getters.getPivotFieldMatching(pivotId, filter.id);
            if (pivotFieldMatching && pivotFieldMatching.chain === field.name) {
                let value = dataSource.getLastPivotGroupValue(domainArgs.slice(-2));
                if (value === NO_RECORD_AT_THIS_POSITION) {
                    continue;
                }
                let transformedValue;
                const currentValue = this.getters.getGlobalFilterValue(filter.id);
                switch (filter.type) {
                    case "date":
                        if (filter.rangeType === "fixedPeriod" && time) {
                            transformedValue = pivotPeriodToFilterValue(time, value);
                            if (JSON.stringify(transformedValue) === JSON.stringify(currentValue)) {
                                transformedValue = undefined;
                            }
                        } else {
                            continue;
                        }
                        break;
                    case "relation":
                        if (typeof value == "string") {
                            value = Number(value);
                            if (Number.isNaN(value)) {
                                break;
                            }
                        }
                        if (JSON.stringify(currentValue) !== `[${value}]`) {
                            transformedValue = [value];
                        }
                        break;
                    case "text":
                        if (currentValue !== value) {
                            transformedValue = value;
                        }
                        break;
                }
                matchingFilters.push({ filterId: filter.id, value: transformedValue });
            }
        }
        return matchingFilters;
    }

    /**
     * @param {string} pivotId
     * @returns {PivotDataSource|undefined}
     */
    getPivotDataSource(pivotId) {
        const dataSourceId = this.getPivotDataSourceId(pivotId);
        return this.dataSources.get(dataSourceId);
    }

    getPivotDataSourceId(pivotId) {
        return `pivot-${pivotId}`;
    }

    isPivotUnused(pivotId) {
        return this._getUnusedPivots().includes(pivotId);
    }

    /**
     * @param {string} pivotId
     * @returns {Promise<PivotDataSource>}
     */
    async getAsyncPivotDataSource(pivotId) {
        const dataSourceId = this.getPivotDataSourceId(pivotId);
        await this.dataSources.load(dataSourceId);
        return this.getPivotDataSource(pivotId);
    }

    // ---------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------

    /**
     * @param {import("../../data_sources/metadata_repository").Field} field
     * @param {"day" | "week" | "month" | "quarter" | "year"} aggregateOperator
     * @returns {string | undefined}
     */
    _getFieldFormat(field, aggregateOperator) {
        switch (field.type) {
            case "integer":
                return "0";
            case "float":
                return "#,##0.00";
            case "monetary":
                return this.getters.getCompanyCurrencyFormat() || "#,##0.00";
            case "date":
            case "datetime": {
                const timeAdapter = pivotTimeAdapter(aggregateOperator);
                return timeAdapter.getFormat(this.getters.getLocale());
            }
            default:
                return undefined;
        }
    }

    /**
     * Refresh the cache of a pivot
     *
     * @param {string} pivotId Id of the pivot
     */
    _refreshOdooPivot(pivotId) {
        const dataSource = this.getters.getPivotDataSource(pivotId);
        dataSource.clearUsedValues();
        dataSource.load({ reload: true });
    }

    /**
     * Refresh the cache of all the pivots
     */
    _refreshOdooPivots() {
        for (const pivotId of this.getters.getPivotIds()) {
            this._refreshOdooPivot(pivotId, false);
        }
    }

    /**
     * Add an additional domain to a pivot
     *
     * @private
     *
     * @param {string} pivotId pivot id
     */
    _addDomain(pivotId) {
        const domainList = [];
        for (const [filterId, fieldMatch] of Object.entries(
            this.getters.getPivotFieldMatch(pivotId)
        )) {
            domainList.push(this.getters.getGlobalFilterDomain(filterId, fieldMatch));
        }
        const domain = Domain.combine(domainList, "AND").toString();
        this.getters.getPivotDataSource(pivotId).addDomain(domain);
    }

    /**
     * Add an additional domain to all pivots
     *
     * @private
     *
     */
    _addDomains() {
        for (const pivotId of this.getters.getPivotIds()) {
            this._addDomain(pivotId);
        }
    }

    /**
     *
     * @return {Promise[]}
     */
    _getPivotsWaitForReady() {
        return this.getters
            .getPivotIds()
            .map((pivotId) => this.getPivotDataSource(pivotId).loadMetadata());
    }

    /**
     * @param {string} pisvotId
     */
    _setupPivotDataSource(pivotId) {
        const dataSourceId = this.getPivotDataSourceId(pivotId);
        const definition = this._getPivotDefinitionForDataSource(pivotId);
        if (!this.dataSources.contains(dataSourceId)) {
            this.dataSources.add(dataSourceId, PivotDataSource, definition);
        }
    }

    _getUnusedPivots() {
        if (this.unusedPivots !== undefined) {
            return this.unusedPivots;
        }
        const unusedPivots = new Set(this.getters.getPivotIds());
        for (const sheetId of this.getters.getSheetIds()) {
            for (const cellId in this.getters.getCells(sheetId)) {
                const position = this.getters.getCellPosition(cellId);
                const pivotId = this.getPivotIdFromPosition(position);
                if (pivotId) {
                    unusedPivots.delete(pivotId);
                    if (!unusedPivots.size) {
                        this.unusedPivots = [];
                        return [];
                    }
                }
            }
        }
        this.unusedPivots = [...unusedPivots];
        return this.unusedPivots;
    }

    /**
     * Get the definition of a pivot, used to setup a data source
     * @param {string} pivotId
     * @returns {import("@spreadsheet").PivotRuntime}
     */
    _getPivotDefinitionForDataSource(pivotId) {
        const definition = this.getters.getPivotDefinition(pivotId);
        return {
            metaData: {
                colGroupBys: definition.colGroupBys,
                rowGroupBys: definition.rowGroupBys,
                activeMeasures: definition.measures,
                resModel: definition.model,
                sortedColumn: definition.sortedColumn,
            },
            searchParams: {
                groupBy: [],
                orderBy: [],
                domain: definition.domain,
                context: definition.context,
            },
            name: definition.name,
        };
    }
}
