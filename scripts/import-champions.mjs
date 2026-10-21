import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const versionsUrl =
  "https://ddragon.leagueoflegends.com/api/versions.json";
const batchSize = 100;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`A variável ${name} não foi definida no arquivo .env.`);
  }
  return value;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Falha ao consultar ${url} (HTTP ${response.status}).`);
  }
  return response.json();
}

async function main() {
  const supabase = createClient(
    requiredEnv("VITE_SUPABASE_URL"),
    requiredEnv("VITE_SUPABASE_ANON_KEY"),
  );

  const versions = await fetchJson(versionsUrl);
  if (!Array.isArray(versions) || typeof versions[0] !== "string") {
    throw new Error("A API da Riot não retornou uma versão válida do Data Dragon.");
  }

  const version = versions[0];
  const championsUrl =
    `https://ddragon.leagueoflegends.com/cdn/${encodeURIComponent(version)}` +
    "/data/pt_BR/champion.json";
  const championResponse = await fetchJson(championsUrl);
  const championData = championResponse?.data;

  if (
    !championData ||
    typeof championData !== "object" ||
    Array.isArray(championData)
  ) {
    throw new Error("A resposta do Data Dragon não contém uma lista de campeões válida.");
  }

  // O campo `name` já vem localizado em português brasileiro pelo Data Dragon.
  const champions = Object.values(championData).map((champion) => ({
    nome: champion?.name,
    id_riot: champion?.id,
  }));

  if (
    champions.length === 0 ||
    champions.some(
      (champion) =>
        typeof champion.nome !== "string" ||
        champion.nome.length === 0 ||
        typeof champion.id_riot !== "string" ||
        champion.id_riot.length === 0,
    )
  ) {
    throw new Error(
      "A resposta do Data Dragon não contém IDs e nomes válidos para todos os campeões.",
    );
  }

  // A carga é substitutiva: primeiro valida a origem e depois esvazia a tabela.
  const { data: deletedRows, error: deleteError } = await supabase
    .from("campeoes")
    .delete()
    .not("id", "is", null)
    .select("id");

  if (deleteError) {
    throw new Error(`Falha ao esvaziar a tabela campeoes: ${deleteError.message}`);
  }

  for (let index = 0; index < champions.length; index += batchSize) {
    const batch = champions.slice(index, index + batchSize);
    const { error: insertError } = await supabase
      .from("campeoes")
      .insert(batch);

    if (insertError) {
      throw new Error(
        `Falha ao inserir o lote ${Math.floor(index / batchSize) + 1}: ${insertError.message}`,
      );
    }
  }

  console.log(
    `Tabela esvaziada (${deletedRows.length} registros removidos) e ${champions.length} campeões de ${version} inseridos com seus IDs do Data Dragon.`,
  );
}

main().catch((error) => {
  console.error(
    `Não foi possível importar os campeões: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
