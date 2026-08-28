declare module 'big.js' {
  export default class Big {
    constructor(value?: string | number | Big);
    plus(value: string | number | Big): Big;
    minus(value: string | number | Big): Big;
    times(value: string | number | Big): Big;
    div(value: string | number | Big): Big;
    abs(): Big;
    lte(value: string | number | Big): boolean;
    gt(value: string | number | Big): boolean;
    eq(value: string | number | Big): boolean;
    toString(): string;
    toFixed(dp?: number): string;
    round(dp?: number, rm?: number): Big;
    static DP: number;
    static roundHalfUp: number;
  }
}
