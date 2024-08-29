import { inject, Injectable, signal } from '@angular/core';
import {
  ActivatedRoute,
  convertToParamMap,
  ParamMap,
  Params,
  Router,
} from '@angular/router';
import { Store } from '@ngrx/store';
import {
  combineLatest,
  debounceTime,
  filter,
  first,
  firstValueFrom,
  map,
  ReplaySubject,
  Subject,
  switchMap,
  takeUntil,
  tap,
} from 'rxjs';

import { coalesce, filterPropsNullish, prune, toParams } from '~/helpers';
import {
  BeaconSettings,
  CostSettings,
  Dataset,
  Entities,
  isRecipeObjective,
  ItemSettings,
  MachineSettings,
  MIN_ZIP,
  ModHash,
  ModuleSettings,
  Objective,
  ObjectiveType,
  ObjectiveUnit,
  QueryField,
  rational,
  RecipeSettings,
  Step,
  ZFIELDSEP,
  Zip,
  ZipData,
  ZipMachineSettings,
  ZipRecipeSettingsInfo,
  ZipVersion,
} from '~/models';
import { App, Items, Machines, Objectives, Recipes, Settings } from '~/store';
import { BrowserUtility } from '~/utilities';
import { CompressionService } from './compression.service';
import { DataService } from './data.service';
import { MigrationService } from './migration.service';
import { ZipService } from './zip.service';

@Injectable({
  providedIn: 'root',
})
export class RouterService {
  router = inject(Router);
  store = inject(Store);
  dataSvc = inject(DataService);
  compressionSvc = inject(CompressionService);
  zipSvc = inject(ZipService);
  migrationSvc = inject(MigrationService);

  zipConfig = signal(this.empty);
  // Current hashing algorithm version
  version = ZipVersion.Version11;
  ready$ = new ReplaySubject<void>(1);
  zip: string | undefined;

  get empty(): Zip<URLSearchParams> {
    return { bare: new URLSearchParams(), hash: new URLSearchParams() };
  }

  get emptyRecipeSettingsInfo(): ZipRecipeSettingsInfo {
    return { idMap: {}, list: [] };
  }

  get emptyMachineSettings(): ZipMachineSettings {
    return { moduleMap: {}, beaconMap: {} };
  }

  private reinit = new Subject<void>();
  initialize(route: ActivatedRoute): void {
    this.reinit.next();
    combineLatest({
      paramMap: route.paramMap,
      queryParamMap: route.queryParamMap,
    })
      .pipe(
        filter(() => {
          const write = this.zip ?? '';
          const read = BrowserUtility.search;
          if (!read) this.ready$.next();
          return write !== read;
        }),
        switchMap(({ paramMap, queryParamMap }) =>
          this.updateState(paramMap.get('id'), queryParamMap),
        ),
        takeUntil(this.reinit),
      )
      .subscribe();

    this.ready$
      .pipe(
        first(),
        tap(() => this.dataSvc.initialize()),
        switchMap(() => this.store.select(Objectives.selectZipState)),
        debounceTime(0),
        filterPropsNullish('hash'),
        map((s) =>
          this.zipState(
            s.objectives,
            s.itemsState,
            s.recipesState,
            s.machinesState,
            s.settings,
            s.data,
            s.hash,
          ),
        ),
        switchMap((z) => this.updateUrl(z)),
        takeUntil(this.reinit),
      )
      .subscribe();
  }

  async updateUrl(zData: ZipData): Promise<void> {
    const zip = await this.getHash(zData);
    this.zip = zip.toString();

    await this.router.navigate([], { queryParams: toParams(zip) });
    const url = this.router.url;
    const path = url.split('?')[0];
    // Only cache list / flow routes
    if (path.endsWith('list') || path.endsWith('flow'))
      BrowserUtility.routerState = url;
  }

  zipState(
    objectives: Objectives.ObjectivesState,
    itemsState: Items.ItemsState,
    recipesState: Recipes.RecipesState,
    machinesState: Machines.MachinesState,
    settings: Settings.SettingsState,
    data: Dataset,
    hash: ModHash,
  ): ZipData {
    // Modules & Beacons
    const zData = this.zipModulesBeacons(
      objectives,
      recipesState,
      machinesState,
      settings,
      hash,
    );

    // Item Objectives
    const o = Object.keys(objectives.entities).map(
      (k) => objectives.entities[k],
    );
    this.zipObjectives(zData, o, hash);

    // Settings
    this.zipItems(zData, itemsState, hash);
    this.zipRecipes(zData, recipesState, hash);
    this.zipMachines(zData, machinesState, hash);
    this.zipSettings(zData, settings, objectives.ids, data, hash);
    zData.config.bare.set(QueryField.Version, this.version);
    zData.config.hash.set(QueryField.Version, this.version);
    this.zipConfig.set(zData.config);
    return zData;
  }

  async stepHref(
    step: Step,
    config: Zip<URLSearchParams>,
    hash: ModHash | undefined,
  ): Promise<string | null> {
    if (hash == null) return null;

    let objectives: Objective[] | undefined;
    if (step.itemId != null && step.items != null) {
      objectives = [
        {
          id: '0',
          targetId: step.itemId,
          value: step.items,
          unit: ObjectiveUnit.Items,
          type: ObjectiveType.Output,
        },
      ];
    } else if (step.recipeId != null && step.machines != null) {
      objectives = [
        {
          id: '0',
          targetId: step.recipeId,
          value: step.machines,
          unit: ObjectiveUnit.Machines,
          type: ObjectiveType.Output,
        },
      ];
    }

    if (objectives == null) return null;

    const zData: ZipData = {
      objectives: this.empty,
      config: config,
      objectiveSettings: this.emptyMachineSettings,
      recipeSettings: this.emptyMachineSettings,
      machineSettings: this.emptyMachineSettings,
    };
    this.zipObjectives(zData, objectives, hash);
    const zHash = await this.getHash(zData);
    return `list?${zHash}`;
  }

  async getHash(zData: ZipData): Promise<URLSearchParams> {
    const bare = new URLSearchParams(zData.objectives.bare);
    zData.config.bare.forEach((value, key) => bare.append(key, value));
    const hash = new URLSearchParams(zData.objectives.hash);
    zData.config.hash.forEach((value, key) => hash.append(key, value));
    const hashStr = decodeURIComponent(hash.toString());
    const zStr = await this.compressionSvc.deflate(hashStr);
    const zip = new URLSearchParams({
      [QueryField.Zip]: zStr,
      [QueryField.Version]: this.version,
    });

    const bareStr = decodeURIComponent(bare.toString());
    const bareLen = bareStr.length;
    const zipStr = decodeURIComponent(zip.toString());
    const zipLen = zipStr.length;
    return bareLen < Math.max(zipLen, MIN_ZIP) ? bare : zip;
  }

  async updateState(modId: string | null, params: ParamMap): Promise<void> {
    if (modId == null || Object.keys(params).length === 0) {
      this.ready$.next();
      return;
    }

    try {
      let isBare = true;
      const zipSection = params.get(QueryField.Zip);
      if (zipSection != null) {
        const zip = await this.compressionSvc.inflate(zipSection);
        const urlParams = new URLSearchParams(zip);
        const ngParams: Params = {};
        for (const key of urlParams.keys())
          ngParams[key] = urlParams.getAll(key);

        params = convertToParamMap(ngParams);
        isBare = false;
      }

      const [_, hash] = await firstValueFrom(
        this.dataSvc.requestData(modId || Settings.initialState.modId),
      );

      const state: App.PartialState = {};
      const useHash = isBare ? undefined : hash;
      const ms = this.unzipModules(params, useHash);
      const bs = this.unzipBeacons(params, ms, useHash);
      state.objectivesState = this.unzipObjectives(params, ms, bs, useHash);
      state.itemsState = this.unzipItems(params, useHash);
      state.recipesState = this.unzipRecipes(params, ms, bs, useHash);
      state.machinesState = this.unzipMachines(params, ms, bs, useHash);
      state.settingsState = this.unzipSettings(
        modId,
        params,
        bs,
        state.objectivesState?.ids ?? [],
        hash,
        useHash,
      );
      prune(state);
      this.dispatch(state);
    } catch (err) {
      console.error(err);
      throw new Error('RouterService failed to parse url');
    } finally {
      this.ready$.next();
    }
  }

  dispatch(partial: App.PartialState): void {
    this.store.dispatch(App.load({ partial }));
    this.ready$.next();
  }

  zipModulesBeacons(
    objectives: Objectives.ObjectivesState,
    recipes: Recipes.RecipesState,
    machines: Machines.MachinesState,
    settings: Settings.SettingsState,
    hash: ModHash,
  ): ZipData {
    const modulesInfo = this.emptyRecipeSettingsInfo;
    const beaconsInfo = this.emptyRecipeSettingsInfo;

    const zip = (
      entities: Entities<Objective | RecipeSettings | MachineSettings>,
    ): ZipMachineSettings => {
      return this.zipMachineSettings(entities, modulesInfo, beaconsInfo, hash);
    };
    const objectiveSettings = zip(objectives.entities);
    const recipeSettings = zip(recipes);
    const machineSettings = zip(machines);

    let beacons: number[] | undefined;
    if (settings.beacons) {
      const moduleMap = this.beaconModuleMap(
        settings.beacons,
        modulesInfo,
        hash,
      );
      beacons = this.zipBeaconArray(
        settings.beacons,
        moduleMap,
        beaconsInfo,
        hash,
      );
    }

    const config = this.empty;
    const data = [
      [QueryField.Module, modulesInfo.list],
      [QueryField.Beacon, beaconsInfo.list],
    ] as const;
    data.forEach(([section, list]) => {
      list.forEach((e) => {
        config.bare.append(section, e.bare);
        config.hash.append(section, e.hash);
      });
    });

    return {
      objectives: this.empty,
      config,
      objectiveSettings,
      recipeSettings,
      machineSettings,
      beacons,
    };
  }

  zipMachineSettings(
    state: Entities<Objective | RecipeSettings | MachineSettings>,
    modulesInfo: ZipRecipeSettingsInfo,
    beaconsInfo: ZipRecipeSettingsInfo,
    hash: ModHash,
  ): ZipMachineSettings {
    const result = this.emptyMachineSettings;
    for (const id of Object.keys(state)) {
      const value = state[id];
      if (value.modules != null) {
        result.moduleMap[id] = this.zipModuleArray(
          value.modules,
          modulesInfo,
          hash,
        );
      }

      if (value.beacons != null) {
        const moduleMap = this.beaconModuleMap(
          value.beacons,
          modulesInfo,
          hash,
        );
        result.beaconMap[id] = this.zipBeaconArray(
          value.beacons,
          moduleMap,
          beaconsInfo,
          hash,
        );
      }
    }

    return result;
  }

  beaconModuleMap(
    beacons: BeaconSettings[],
    modulesInfo: ZipRecipeSettingsInfo,
    hash: ModHash,
  ): (number[] | undefined)[] {
    return beacons.map((beacon) => {
      if (beacon.modules == null) return undefined;
      return this.zipModuleArray(beacon.modules, modulesInfo, hash);
    });
  }

  zipModuleArray(
    values: ModuleSettings[],
    modulesInfo: ZipRecipeSettingsInfo,
    hash: ModHash,
  ): number[] {
    return values.map((obj) => {
      const count = this.zipSvc.zipString(obj.count?.toString());
      const zip: Zip<string> = {
        bare: this.zipSvc.zipFields([count, this.zipSvc.zipString(obj.id)]),
        hash: this.zipSvc.zipFields([
          count,
          this.zipSvc.zipNString(obj.id, hash.modules),
        ]),
      };

      if (modulesInfo.idMap[zip.bare] == null) {
        modulesInfo.idMap[zip.bare] = modulesInfo.list.length;
        modulesInfo.list.push(zip);
      }

      return modulesInfo.idMap[zip.bare];
    });
  }

  unzipModules(params: ParamMap, hash?: ModHash): ModuleSettings[] {
    const list = params.getAll(QueryField.Module);
    return list.map((module) => {
      const s = module.split(ZFIELDSEP);
      let i = 0;
      const obj: ModuleSettings = {
        count: this.zipSvc.parseRational(this.zipSvc.parseString(s[i++])),
        id: this.zipSvc.parseString(s[i++], hash?.modules),
      };

      prune(obj);
      return obj;
    });
  }

  zipBeaconArray(
    beacons: BeaconSettings[],
    moduleMap: (number[] | undefined)[],
    beaconsInfo: ZipRecipeSettingsInfo,
    hash: ModHash,
  ): number[] {
    return beacons.map((obj, i) => {
      const count = this.zipSvc.zipString(obj.count?.toString());
      const modules = this.zipSvc.zipArray(moduleMap[i]);
      const total = this.zipSvc.zipString(obj.total?.toString());
      const zip: Zip<string> = {
        bare: this.zipSvc.zipFields([
          count,
          modules,
          this.zipSvc.zipString(obj.id),
          total,
        ]),
        hash: this.zipSvc.zipFields([
          count,
          modules,
          this.zipSvc.zipNString(obj.id, hash.beacons),
          total,
        ]),
      };

      if (beaconsInfo.idMap[zip.bare] == null) {
        beaconsInfo.idMap[zip.bare] = beaconsInfo.list.length;
        beaconsInfo.list.push(zip);
      }

      return beaconsInfo.idMap[zip.bare];
    });
  }

  unzipBeacons(
    params: ParamMap,
    moduleSettings: ModuleSettings[],
    hash?: ModHash,
  ): BeaconSettings[] {
    const list = params.getAll(QueryField.Beacon);
    return list.map((beacon) => {
      const s = beacon.split(ZFIELDSEP);
      let i = 0;
      const obj: BeaconSettings = {
        count: this.zipSvc.parseRational(this.zipSvc.parseString(s[i++])),
        modules: this.zipSvc
          .parseArray(s[i++])
          ?.map((i) => coalesce(moduleSettings[Number(i)], {})),
        id: this.zipSvc.parseString(s[i++], hash?.beacons),
        total: this.zipSvc.parseRational(this.zipSvc.parseString(s[i++])),
      };

      prune(obj);
      return obj;
    });
  }

  zipObjectives(data: ZipData, objectives: Objective[], hash: ModHash): void {
    objectives.forEach((obj) => {
      const value = this.zipSvc.zipDiffRational(obj.value, rational.one);
      const unit = this.zipSvc.zipDiffNumber(obj.unit, ObjectiveUnit.Items);
      const type = this.zipSvc.zipDiffNumber(obj.type, ObjectiveType.Output);
      const modules = this.zipSvc.zipArray(
        data.objectiveSettings.moduleMap[obj.id],
      );
      const beacons = this.zipSvc.zipArray(
        data.objectiveSettings.beaconMap[obj.id],
      );
      const overclock = this.zipSvc.zipNumber(obj.overclock);

      data.objectives.bare.append(
        QueryField.Objective,
        this.zipSvc.zipFields([
          obj.targetId,
          value,
          unit,
          type,
          this.zipSvc.zipString(obj.machineId),
          modules,
          beacons,
          overclock,
          this.zipSvc.zipString(obj.fuelId),
        ]),
      );
      data.objectives.hash.append(
        QueryField.Objective,
        this.zipSvc.zipFields([
          this.zipSvc.zipNString(
            obj.targetId,
            isRecipeObjective(obj) ? hash.recipes : hash.items,
          ),
          value,
          unit,
          type,
          this.zipSvc.zipNString(obj.machineId, hash.machines),
          modules,
          beacons,
          overclock,
          this.zipSvc.zipNString(obj.fuelId, hash.fuels),
        ]),
      );
    });
  }

  unzipObjectives(
    params: ParamMap,
    moduleSettings: ModuleSettings[],
    beaconSettings: BeaconSettings[],
    hash?: ModHash,
  ): Objectives.ObjectivesState | undefined {
    const list = params.getAll(QueryField.Objective);
    if (!list.length) return undefined;

    const ids: string[] = [];
    const entities: Entities<Objective> = {};
    let index = 1;
    for (const itemObjective of list) {
      const s = itemObjective.split(ZFIELDSEP);
      let i = 0;
      const id = index.toString();
      const obj: Objective = {
        id: index.toString(),
        targetId: s[i++], // Convert to real id after determining unit, if hashed
        value: coalesce(this.zipSvc.parseRational(s[i++]), rational.one),
        unit: this.zipSvc.parseNumber(s[i++]) ?? ObjectiveUnit.Items,
        type: this.zipSvc.parseNumber(s[i++]) ?? ObjectiveType.Output,
        machineId: this.zipSvc.parseString(s[i++], hash?.machines),
        modules: this.zipSvc
          .parseArray(s[i++])
          ?.map((i) => moduleSettings[Number(i)] ?? {}),
        beacons: this.zipSvc
          .parseArray(s[i++])
          ?.map((i) => beaconSettings[Number(i)] ?? {}),
        overclock: this.zipSvc.parseRational(s[i++]),
        fuelId: this.zipSvc.parseString(s[i++], hash?.fuels),
      };

      if (hash) {
        obj.targetId = coalesce(
          this.zipSvc.parseNString(
            obj.targetId,
            isRecipeObjective(obj) ? hash.recipes : hash.items,
          ),
          '',
        );
      }

      prune(obj);
      ids.push(id);
      entities[id] = obj;
      index++;
    }
    return { ids, index, entities };
  }

  zipItems(data: ZipData, state: Items.ItemsState, hash: ModHash): void {
    Object.keys(state).forEach((i) => {
      const obj = state[i];
      data.config.bare.append(
        QueryField.Item,
        this.zipSvc.zipFields([
          i,
          this.zipSvc.zipString(obj.beltId),
          this.zipSvc.zipString(obj.wagonId),
        ]),
      );
      data.config.hash.append(
        QueryField.Item,
        this.zipSvc.zipFields([
          this.zipSvc.zipNString(i, hash.items),
          this.zipSvc.zipNString(obj.beltId, hash.belts),
          this.zipSvc.zipNString(obj.wagonId, hash.wagons),
        ]),
      );
    });
  }

  unzipItems(params: ParamMap, hash?: ModHash): Items.ItemsState | undefined {
    const list = params.getAll(QueryField.Item);
    if (!list.length) return undefined;

    const entities: Items.ItemsState = {};
    for (const item of list) {
      const s = item.split(ZFIELDSEP);
      let i = 0;
      const id = coalesce(this.zipSvc.parseString(s[i++], hash?.items), '');
      const obj: ItemSettings = {
        beltId: this.zipSvc.parseString(s[i++], hash?.belts),
        wagonId: this.zipSvc.parseString(s[i++], hash?.wagons),
      };

      prune(obj);
      entities[id] = obj;
    }
    return entities;
  }

  zipRecipes(data: ZipData, state: Recipes.RecipesState, hash: ModHash): void {
    Object.keys(state).forEach((i) => {
      const obj = state[i];
      const modules = this.zipSvc.zipArray(data.recipeSettings.moduleMap[i]);
      const beacons = this.zipSvc.zipArray(data.recipeSettings.beaconMap[i]);
      const overclock = this.zipSvc.zipNumber(obj.overclock);
      const cost = this.zipSvc.zipNumber(obj.cost);

      data.config.bare.append(
        QueryField.Recipe,
        this.zipSvc.zipFields([
          i,
          this.zipSvc.zipString(obj.machineId),
          modules,
          beacons,
          overclock,
          cost,
          this.zipSvc.zipString(obj.fuelId),
        ]),
      );
      data.config.hash.append(
        QueryField.Recipe,
        this.zipSvc.zipFields([
          this.zipSvc.zipNString(i, hash.recipes),
          this.zipSvc.zipNString(obj.machineId, hash.machines),
          modules,
          beacons,
          overclock,
          cost,
          this.zipSvc.zipNString(obj.fuelId, hash.fuels),
        ]),
      );
    });
  }

  unzipRecipes(
    params: ParamMap,
    moduleSettings: ModuleSettings[],
    beaconSettings: BeaconSettings[],
    hash?: ModHash,
  ): Recipes.RecipesState | undefined {
    const list = params.getAll(QueryField.Recipe);
    if (!list.length) return undefined;

    const entities: Recipes.RecipesState = {};
    for (const recipe of list) {
      const s = recipe.split(ZFIELDSEP);
      let i = 0;
      const id = this.zipSvc.parseString(s[i++], hash?.recipes) ?? '';
      const obj: RecipeSettings = {
        machineId: this.zipSvc.parseString(s[i++], hash?.machines),
        modules: this.zipSvc
          .parseArray(s[i++])
          ?.map((i) => moduleSettings[Number(i)] ?? {}),
        beacons: this.zipSvc
          .parseArray(s[i++])
          ?.map((i) => beaconSettings[Number(i)] ?? {}),
        overclock: this.zipSvc.parseRational(s[i++]),
        cost: this.zipSvc.parseRational(s[i++]),
        fuelId: this.zipSvc.parseString(s[i++], hash?.fuels),
      };

      prune(obj);
      entities[id] = obj;
    }
    return entities;
  }

  zipMachines(
    data: ZipData,
    state: Machines.MachinesState,
    hash: ModHash,
  ): void {
    Object.keys(state).forEach((i) => {
      const obj = state[i];
      const modules = this.zipSvc.zipArray(data.machineSettings.moduleMap[i]);
      const beacons = this.zipSvc.zipArray(data.machineSettings.beaconMap[i]);
      const overclock = this.zipSvc.zipNumber(obj.overclock);

      data.config.bare.append(
        QueryField.Machine,
        this.zipSvc.zipFields([
          i,
          modules,
          beacons,
          this.zipSvc.zipString(obj.fuelId),
          overclock,
        ]),
      );
      data.config.hash.append(
        QueryField.Machine,
        this.zipSvc.zipFields([
          this.zipSvc.zipNString(i, hash.machines),
          modules,
          beacons,
          this.zipSvc.zipNString(obj.fuelId, hash.fuels),
          overclock,
        ]),
      );
    });
  }

  unzipMachines(
    params: ParamMap,
    moduleSettings: ModuleSettings[],
    beaconSettings: BeaconSettings[],
    hash?: ModHash,
  ): Machines.MachinesState | undefined {
    const list = params.getAll(QueryField.Machine);
    if (!list.length) return undefined;

    const entities: Machines.MachinesState = {};
    for (const machine of list) {
      const s = machine.split(ZFIELDSEP);
      let i = 0;
      const id = this.zipSvc.parseString(s[i++], hash?.machines) ?? '';
      const obj: MachineSettings = {
        modules: this.zipSvc
          .parseArray(s[i++])
          ?.map((i) => moduleSettings[Number(i)] ?? {}),
        beacons: this.zipSvc
          .parseArray(s[i++])
          ?.map((i) => beaconSettings[Number(i)] ?? {}),
        fuelId: this.zipSvc.parseString(s[i++], hash?.fuels),
        overclock: this.zipSvc.parseRational(s[i++]),
      };

      prune(obj);
      entities[id] = obj;
    }

    return entities;
  }

  zipSettings(
    zData: ZipData,
    state: Settings.SettingsState,
    objectiveIds: string[],
    data: Dataset,
    hash: ModHash,
  ): void {
    const init = Settings.initialState;

    const Q = QueryField;

    // Set up shorthand functions to zip state
    const set = this.zipSvc.set(zData, state, init);
    const sub = set(this.zipSvc.zipDiffSubset);
    const num = set(this.zipSvc.zipDiffNumber);
    const bln = set(this.zipSvc.zipDiffBool);
    const str = set(this.zipSvc.zipDiffString);
    const rat = set(this.zipSvc.zipDiffRational);
    const rnk = set(this.zipSvc.zipDiffArray);
    const arr = set(this.zipSvc.zipDiffIndices);

    // Zip state
    sub(Q.ObjectiveChecked, (s) => s.checkedObjectiveIds, objectiveIds);
    num(Q.ObjectiveMaximizeType, (s) => s.maximizeType);
    bln(Q.ObjectiveSurplusMachines, (s) => s.surplusMachinesOutput);
    num(Q.ObjectiveDisplayRate, (s) => s.displayRate);
    sub(Q.ItemExcluded, (s) => s.excludedItemIds, data.itemIds, hash.items);
    sub(Q.ItemChecked, (s) => s.checkedItemIds, data.itemIds, hash.items);
    str(Q.ItemBelt, (s) => s.beltId, hash.belts);
    str(Q.ItemPipe, (s) => s.pipeId, hash.belts);
    str(Q.ItemCargoWagon, (s) => s.cargoWagonId, hash.wagons);
    str(Q.ItemFluidWagon, (s) => s.fluidWagonId, hash.wagons);
    rat(Q.ItemFlowRate, (s) => s.flowRate);
    sub(
      Q.RecipeExcluded,
      (s) => s.excludedRecipeIds,
      data.recipeIds,
      hash.recipes,
    );
    sub(
      Q.RecipeChecked,
      (s) => s.checkedRecipeIds,
      data.recipeIds,
      hash.recipes,
    );
    bln(Q.RecipeNetProduction, (s) => s.netProductionOnly);
    num(Q.MachinePreset, (s) => s.preset);
    rnk(Q.MachineRank, (s) => s.machineRankIds, hash.machines);
    rnk(Q.MachineFuelRank, (s) => s.fuelRankIds, hash.fuels);
    rnk(Q.MachineModuleRank, (s) => s.moduleRankIds, hash.modules);
    arr(Q.MachineBeacons, (s) => (s === init ? undefined : zData.beacons));
    rat(Q.MachineOverclock, (s) => s.overclock);
    rat(Q.MachineBeaconReceivers, (s) => s.beaconReceivers);
    str(Q.MachineProliferatorSpray, (s) => s.proliferatorSprayId, hash.modules);
    num(Q.MachineInserterTarget, (s) => s.inserterTarget);
    rat(Q.BonusMining, (s) => s.miningBonus);
    rat(Q.BonusResearch, (s) => s.researchBonus);
    num(Q.BonusInserterCapacity, (s) => s.inserterCapacity);
    sub(
      Q.TechnologyResearched,
      (s) => s.researchedTechnologyIds,
      data.technologyIds,
      hash.technologies,
    );
    rat(Q.CostFactor, (s) => s.costs.factor);
    rat(Q.CostMachine, (s) => s.costs.machine);
    rat(Q.CostFootprint, (s) => s.costs.footprint);
    rat(Q.CostUnproduceable, (s) => s.costs.unproduceable);
    rat(Q.CostExcluded, (s) => s.costs.excluded);
    rat(Q.CostSurplus, (s) => s.costs.surplus);
    rat(Q.CostMaximize, (s) => s.costs.maximize);
  }

  unzipSettings(
    modId: string,
    params: ParamMap,
    beaconSettings: BeaconSettings[],
    objectiveIds: string[],
    modHash: ModHash,
    hash?: ModHash,
  ): Settings.PartialSettingsState | undefined {
    const Q = QueryField;

    // Set up shorthand functions to parse state
    const get = this.zipSvc.get(params);
    const sub = get(this.zipSvc.parseSubset);
    const nsb = get(this.zipSvc.parseNullableSubset);
    const num = get(this.zipSvc.parseNumber);
    const bln = get(this.zipSvc.parseBool);
    const str = get(this.zipSvc.parseString);
    const rat = get(this.zipSvc.parseRational);
    const rnk = get(this.zipSvc.parseArray);
    const arr = get(this.zipSvc.parseIndices);

    const obj: Settings.PartialSettingsState = {
      modId,
      checkedObjectiveIds: sub(Q.ObjectiveMaximizeType, objectiveIds),
      maximizeType: num(Q.ObjectiveMaximizeType),
      surplusMachinesOutput: bln(Q.ObjectiveSurplusMachines),
      displayRate: num(Q.ObjectiveDisplayRate),
      excludedItemIds: sub(Q.ItemExcluded, modHash.items),
      checkedItemIds: sub(Q.ItemChecked, modHash.items),
      beltId: str(Q.ItemBelt, hash?.belts),
      pipeId: str(Q.ItemPipe, hash?.belts),
      cargoWagonId: str(Q.ItemCargoWagon, hash?.wagons),
      fluidWagonId: str(Q.ItemFluidWagon, hash?.wagons),
      flowRate: rat(Q.ItemFlowRate),
      excludedRecipeIds: sub(Q.RecipeExcluded, modHash.recipes),
      checkedRecipeIds: sub(Q.RecipeChecked, modHash.recipes),
      netProductionOnly: bln(Q.RecipeNetProduction),
      preset: num(Q.MachinePreset),
      machineRankIds: rnk(Q.MachineRank, hash?.machines),
      fuelRankIds: rnk(Q.MachineFuelRank, hash?.fuels),
      moduleRankIds: rnk(Q.MachineModuleRank, hash?.modules),
      beacons: arr(Q.MachineBeacons)?.map((i) => beaconSettings[i] ?? {}),
      overclock: rat(Q.MachineOverclock),
      beaconReceivers: rat(Q.MachineBeaconReceivers),
      proliferatorSprayId: str(Q.MachineProliferatorSpray, hash?.modules),
      inserterTarget: num(Q.MachineInserterTarget),
      miningBonus: rat(Q.BonusMining),
      researchBonus: rat(Q.BonusResearch),
      inserterCapacity: num(Q.BonusInserterCapacity),
      researchedTechnologyIds: nsb(
        Q.TechnologyResearched,
        modHash.technologies,
      ),
    };

    const costs: Partial<CostSettings> = {
      factor: rat(Q.CostFactor),
      machine: rat(Q.CostMachine),
      footprint: rat(Q.CostFootprint),
      unproduceable: rat(Q.CostUnproduceable),
      excluded: rat(Q.CostExcluded),
      surplus: rat(Q.CostSurplus),
      maximize: rat(Q.CostMaximize),
    };

    prune(costs);
    if (Object.keys(costs).length) obj.costs = costs;

    prune(obj);
    if (Object.keys(obj).length === 0) return undefined;

    return obj;
  }
}
