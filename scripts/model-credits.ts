#!/usr/bin/env bun

export {};

const DEFAULT_DATA_JSONS = [
  '/Users/wenkai/tmp/modes.msa.json',
  '/Users/wenkai/tmp/modes.aad.json',
];

type Price = {
  input_price: number;
  output_price: number;
};

type Model = {
  name: string;
  model_picker_enabled: boolean;
  billing: {
    token_prices: {
      default: Price;
      long_context?: Price;
    };
  };
};

type ModelsResponse = {
  data: Model[];
};

const headers = [
  'Model',
  'Short input credit',
  'Short output credit',
  'Long input credit',
  'Long output credit',
];

const requestedPaths: string[] = [];
const args = process.argv.slice(2);

for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--data-json') throw new Error(`Unknown argument: ${args[i]}`);
  requestedPaths.push(args[++i]);
}

const dataJsonPaths = requestedPaths.length > 0 ? requestedPaths : DEFAULT_DATA_JSONS;

for (const [index, dataJsonPath] of dataJsonPaths.entries()) {
  if (index > 0) console.log();
  console.log(`Data JSON: ${dataJsonPath}`);
  const response = (await Bun.file(dataJsonPath).json()) as ModelsResponse;
  const rows = response.data
    .filter(model => model.model_picker_enabled === true)
    .sort((a, b) =>
      a.name.localeCompare(b.name) ||
      a.billing.token_prices.default.output_price - b.billing.token_prices.default.output_price ||
      (a.billing.token_prices.long_context?.output_price ?? Infinity) -
        (b.billing.token_prices.long_context?.output_price ?? Infinity),
    )
    .map(model => {
      const prices = model.billing.token_prices;
      return [
        model.name,
        String(prices.default.input_price / 100),
        String(prices.default.output_price / 100),
        prices.long_context ? String(prices.long_context.input_price / 100) : '-',
        prices.long_context ? String(prices.long_context.output_price / 100) : '-',
      ];
    });

  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map(row => row[column].length)),
  );
  const separator = widths.map(width => '-'.repeat(width)).join('-+-');
  const formatRow = (row: string[]) =>
    row.map((value, column) => value.padEnd(widths[column])).join(' | ');

  console.log([headers, ...rows].map(formatRow).join(`\n${separator}\n`));
}
