export const SCIENTIST_NAMES = [
  "Ampere",
  "Archimedes",
  "Avogadro",
  "Banach",
  "Bernoulli",
  "Bohr",
  "Boltzmann",
  "Boyle",
  "Brahe",
  "Cantor",
  "Cauchy",
  "Chadwick",
  "Compton",
  "Copernicus",
  "Curie",
  "Dalton",
  "Darwin",
  "Dirac",
  "Euclid",
  "Euler",
  "Faraday",
  "Fermi",
  "Feynman",
  "Fourier",
  "Franklin",
  "Galileo",
  "Gauss",
  "Godel",
  "Halley",
  "Hawking",
  "Heisenberg",
  "Hertz",
  "Hilbert",
  "Hooke",
  "Hopper",
  "Hubble",
  "Hypatia",
  "Joule",
  "Kelvin",
  "Kepler",
  "Kolmogorov",
  "Laplace",
  "Lavoisier",
  "Lovelace",
  "Maxwell",
  "Meitner",
  "Mendel",
  "Mendeleev",
  "Newton",
  "Noether",
  "Ohm",
  "Pasteur",
  "Pauli",
  "Planck",
  "Poincare",
  "Pythagoras",
  "Ramanujan",
  "Riemann",
  "Rutherford",
  "Sagan",
  "Schrodinger",
  "Shannon",
  "Tesla",
  "Thomson",
  "Turing",
  "Volta",
  "Watt",
  "Weber",
] as const;

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

export function pickUniqueScientistName(
  used: Iterable<string>,
  random: () => number = Math.random,
): string {
  const usedSet = new Set(
    [...used].map(normalizeName).filter((name) => name.length > 0),
  );
  const available = SCIENTIST_NAMES.filter(
    (name) => !usedSet.has(normalizeName(name)),
  );
  if (available.length > 0) {
    const index = Math.min(
      available.length - 1,
      Math.max(0, Math.floor(random() * available.length)),
    );
    return available[index] ?? SCIENTIST_NAMES[0];
  }

  const baseIndex = Math.min(
    SCIENTIST_NAMES.length - 1,
    Math.max(0, Math.floor(random() * SCIENTIST_NAMES.length)),
  );
  const base = SCIENTIST_NAMES[baseIndex] ?? "Curie";
  let suffix = 2;
  while (usedSet.has(normalizeName(`${base} ${suffix}`))) {
    suffix += 1;
  }
  return `${base} ${suffix}`;
}
