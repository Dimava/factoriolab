import { inject, Injectable } from '@angular/core';

import {
  Nullable,
  rational,
  Rational,
  ZARRAYSEP,
  ZEMPTY,
  ZFALSE,
  ZFIELDSEP,
  ZNULL,
  ZTRUE,
} from '~/models';
import { CompressionService } from './compression.service';

@Injectable({
  providedIn: 'root',
})
export class ZipService {
  compressionSvc = inject(CompressionService);

  zipFields(fields: string[]): string {
    return fields.join(ZFIELDSEP).replace(/\**$/, '');
  }

  zipString(value: string | undefined): string {
    return value == null ? '' : value;
  }

  zipNumber(value: number | Rational | undefined): string {
    return value == null ? '' : value.toString();
  }

  zipArray(value: string[] | number[] | undefined): string {
    return value == null ? '' : value.length ? value.join(ZARRAYSEP) : ZEMPTY;
  }

  zipNString(value: Nullable<string>, hash: string[]): string {
    return value == null ? '' : this.compressionSvc.nToId(hash.indexOf(value));
  }

  zipDiffSubset(
    value: Nullable<Set<string>>,
    init: Nullable<Set<string>>,
    all: string[],
    hash: string[] = all,
  ): string {
    if (value == null) {
      if (init == null) return '';
      return ZNULL;
    }

    if (value.size === 0) {
      if (init?.size === 0) return '';
      return ZEMPTY;
    }

    const allSet = new Set(all);
    const result: string[] = [];
    let start: string | undefined;
    let end: string | undefined;
    hash.forEach((h, i) => {
      if (!allSet.has(h)) return;

      if (value.has(h)) {
        const j = this.compressionSvc.nToId(i);
        if (start == null) start = j;
        else end = j;
      } else if (start != null) {
        if (end == null) result.push(start);
        else result.push(start + ZARRAYSEP + end);
        start = undefined;
        end = undefined;
      }
    });

    if (start != null) {
      if (end == null) result.push(start);
      else result.push(start + ZARRAYSEP + end);
    }

    return result.join(ZFIELDSEP);
  }

  zipDiffString(
    value: Nullable<string>,
    init: Nullable<string>,
    hash: string[],
  ): string | [string, string] {
    return value === init
      ? ''
      : value == null
        ? ZNULL
        : [value, this.compressionSvc.nToId(hash.indexOf(value))];
  }

  zipDiffNumber(value: Nullable<number>, init: Nullable<number>): string {
    return value === init ? '' : value == null ? ZNULL : value.toString();
  }

  zipDiffRational(value: Nullable<Rational>, init: Nullable<Rational>): string {
    return (value == null ? init == null : init != null && value.eq(init))
      ? ''
      : value == null
        ? ZNULL
        : value.toString();
  }

  zipDiffBool(value: boolean, init: boolean): string {
    return value === init ? '' : value ? ZTRUE : ZFALSE;
  }

  zipDiffIndices(
    value: Nullable<number[]>,
    init: Nullable<number[]>,
  ): string | [string, string] {
    const zVal =
      value != null
        ? value.length > 0
          ? value.join(ZARRAYSEP)
          : ZEMPTY
        : ZNULL;
    const zInit =
      init != null ? (init.length > 0 ? init.join(ZARRAYSEP) : ZEMPTY) : ZNULL;
    return zVal === zInit ? '' : zVal;
  }

  zipDiffArray(
    value: Nullable<string[]>,
    init: Nullable<string[]>,
    hash: string[],
  ): string | [string, string] {
    const zVal =
      value != null
        ? value.length > 0
          ? value.join(ZARRAYSEP)
          : ZEMPTY
        : ZNULL;
    const zInit =
      init != null ? (init.length > 0 ? init.join(ZARRAYSEP) : ZEMPTY) : ZNULL;
    return zVal === zInit
      ? ''
      : value == null
        ? ZNULL
        : [
            zVal,
            value
              .map((v) => this.compressionSvc.nToId(hash.indexOf(v)))
              .join(ZARRAYSEP),
          ];
  }

  parseString(value: Nullable<string>, hash?: string[]): string | undefined {
    if (hash != null) return this.parseNString(value, hash);
    if (!value?.length || value === ZNULL) return undefined;
    return value;
  }

  parseBool(value: Nullable<string>): boolean | undefined {
    if (!value?.length || value === ZNULL) return undefined;
    return value === ZTRUE;
  }

  parseNumber(value: Nullable<string>, useNNumber = false): number | undefined {
    if (useNNumber) return this.parseNNumber(value);
    if (!value?.length || value === ZNULL) return undefined;
    return Number(value);
  }

  parseRational(value: Nullable<string>): Rational | undefined {
    if (!value?.length || value === ZNULL) return undefined;
    return rational(value);
  }

  parseArray(value: Nullable<string>, hash?: string[]): string[] | undefined {
    if (hash) return this.parseNArray(value, hash);
    if (!value?.length || value === ZNULL) return undefined;
    return value === ZEMPTY ? [] : value.split(ZARRAYSEP);
  }

  parseNString(value: Nullable<string>, hash: string[]): string | undefined {
    const v = this.parseString(value);
    if (v == null) return v;
    return hash[this.compressionSvc.idToN(v)];
  }

  parseNNumber(value: Nullable<string>): number | undefined {
    if (!value?.length || value === ZNULL) return undefined;
    return this.compressionSvc.idToN(value);
  }

  parseNArray(value: Nullable<string>, hash: string[]): string[] | undefined {
    const v = this.parseArray(value);
    if (v == null) return v;
    return v.map((a) => hash[this.compressionSvc.idToN(a)]);
  }

  parseSubset(
    value: Nullable<string>,
    hash: string[],
  ): Set<string> | null | undefined {
    if (!value?.length) return undefined;
    if (value === ZNULL) return null;
    if (value === ZEMPTY) return new Set();

    const ranges = value.split(ZFIELDSEP);
    const result = new Set<string>();
    for (const range of ranges) {
      const [start, end] = range
        .split(ZARRAYSEP)
        .map((i) => this.compressionSvc.idToN(i));
      const sliceEnd = end != null ? end + 1 : start + 1;
      const slice = hash.slice(start, sliceEnd);
      slice.forEach((i) => result.add(i));
    }

    return result;
  }
}
