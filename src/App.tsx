import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { PostgrestError, Session, User } from "@supabase/supabase-js";
import { supabase } from "./lib/supabaseClient";

type AuthViewMode = "login" | "signup" | "forgot" | "reset";

type Champion = {
  id: string;
  nome: string;
  criado_em: string | null;
  id_riot: string | null;
};

type Feedback = {
  kind: "success" | "error";
  text: string;
};

type RiotCatalog = {
  version: string;
  titles: Record<string, string>;
  idsByName: Record<string, string>;
};

type RiotApiChampion = {
  id?: unknown;
  name?: unknown;
  title?: unknown;
};

type Achievement = {
  id: string;
  titulo: string;
  descricao: string;
  icone: string;
  requisito_tipo: "acertos_count" | "crud_action";
  requisito_qtd: number;
};

type Toast = {
  id: number;
  text: string;
  kind: "success" | "error";
};

const STORAGE_KEY = "janna-champions-found";
const ACHIEVEMENTS_STORAGE_KEY = "janna-unlocked-achievements";
const CRUD_ACTIONS_STORAGE_KEY = "janna-crud-actions";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const achievementOrder = [
  "Primeira Brisa",
  "Rajada Crescente",
  "Vendaval de Runeterra",
  "Tempestade Iminente",
  "Olho do Furacão",
  "Sopros da Criação",
];
let riotCatalogRequest: Promise<RiotCatalog> | null = null;

async function loadRiotCatalog(): Promise<RiotCatalog> {
  const versionsResponse = await fetch(
    "https://ddragon.leagueoflegends.com/api/versions.json",
  );
  if (!versionsResponse.ok) {
    throw new Error("Não foi possível consultar a versão do Data Dragon.");
  }

  const versions: unknown = await versionsResponse.json();
  if (!Array.isArray(versions) || typeof versions[0] !== "string") {
    throw new Error("A API do Data Dragon não retornou uma versão válida.");
  }

  const version = versions[0];
  const catalogResponse = await fetch(
    `https://ddragon.leagueoflegends.com/cdn/${encodeURIComponent(version)}/data/pt_BR/champion.json`,
  );
  if (!catalogResponse.ok) {
    throw new Error("Não foi possível carregar os retratos dos campeões.");
  }

  const catalog: { data?: Record<string, RiotApiChampion> } =
    await catalogResponse.json();
  if (!catalog.data || typeof catalog.data !== "object") {
    throw new Error("O catálogo de campeões do Data Dragon é inválido.");
  }

  const titles: Record<string, string> = {};
  const idsByName: Record<string, string> = {};
  for (const champion of Object.values(catalog.data)) {
    if (typeof champion.id !== "string") continue;
    if (typeof champion.title === "string") titles[champion.id] = champion.title;
    if (typeof champion.name === "string") idsByName[champion.name] = champion.id;
  }

  return { version, titles, idsByName };
}

function getRiotCatalog(): Promise<RiotCatalog> {
  riotCatalogRequest ??= loadRiotCatalog();
  return riotCatalogRequest;
}

function errorMessage(error: PostgrestError): string {
  if (error.code === "23505") {
    return "Esse campeão já está no banco.";
  }

  return "Não foi possível concluir a operação. Tente novamente.";
}

function readStoredNames(key: string): string[] {
  const saved = localStorage.getItem(key);
  if (!saved) return [];

  const parsed: unknown = JSON.parse(saved);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Os dados salvos neste navegador estão em um formato inválido.");
  }
  return [...new Set(parsed)];
}

function DesafioApp({ user }: { user: User }) {
  const authUser = user;
  const [activePage, setActivePage] = useState<"desafio" | "admin">("desafio");
  const [champions, setChampions] = useState<Champion[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [guessedNames, setGuessedNames] = useState<string[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [challengeInput, setChallengeInput] = useState("");
  const [challengeFeedback, setChallengeFeedback] = useState<Feedback | null>(
    null,
  );
  const [newChampion, setNewChampion] = useState("");
  const [adminFeedback, setAdminFeedback] = useState<Feedback | null>(null);
  const [adminSearch, setAdminSearch] = useState("");
  const [adminChampion, setAdminChampion] = useState<Champion | null>(null);
  const [editingName, setEditingName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [riotCatalog, setRiotCatalog] = useState<RiotCatalog | null>(null);
  const [riotCatalogError, setRiotCatalogError] = useState("");
  const [safeSearchMode, setSafeSearchMode] = useState<"starts" | "contains">(
    "starts",
  );
  const [safeSearchInput, setSafeSearchInput] = useState("");
  const [safeSearchResult, setSafeSearchResult] = useState<Feedback | null>(
    null,
  );
  const [showAchievements, setShowAchievements] = useState(false);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [achievementCatalogLoaded, setAchievementCatalogLoaded] = useState(false);
  const [unlockedAchievementIds, setUnlockedAchievementIds] = useState<
    string[]
  >([]);
  const [accountSyncing, setAccountSyncing] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [crudActionCount, setCrudActionCount] = useState(0);
  const unlockedAchievementIdsRef = useRef(new Set<string>());
  const syncingUserIdRef = useRef<string | null>(null);
  const syncedUserIdRef = useRef<string | null>(null);
  const toastSequenceRef = useRef(0);

  const guessedSet = useMemo(() => new Set(guessedNames), [guessedNames]);
  const sortedGuesses = useMemo(
    () => [...guessedNames].sort((a, b) => a.localeCompare(b, "pt-BR")),
    [guessedNames],
  );
  const championByName = useMemo(
    () => new Map(champions.map((champion) => [champion.nome, champion])),
    [champions],
  );
  const letterDistribution = useMemo(() => {
    const counts = new Map(alphabet.map((letter) => [letter, 0]));
    for (const champion of champions) {
      const firstLetter = champion.nome
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .charAt(0)
        .toLocaleUpperCase("pt-BR");
      if (counts.has(firstLetter)) {
        counts.set(firstLetter, (counts.get(firstLetter) ?? 0) + 1);
      }
    }
    return alphabet.map((letter) => ({
      letter,
      count: counts.get(letter) ?? 0,
    }));
  }, [champions]);
  const largestLetterCount = Math.max(
    1,
    ...letterDistribution.map(({ count }) => count),
  );

  useEffect(() => {
    try {
      setGuessedNames(readStoredNames(STORAGE_KEY));
      const unlocked = readStoredNames(ACHIEVEMENTS_STORAGE_KEY);
      unlockedAchievementIdsRef.current = new Set(unlocked);
      setUnlockedAchievementIds(unlocked);
      const actionCount = Number(
        localStorage.getItem(CRUD_ACTIONS_STORAGE_KEY) ?? "0",
      );
      setCrudActionCount(
        Number.isSafeInteger(actionCount) && actionCount > 0 ? actionCount : 0,
      );
    } catch {
      setStorageError(
        "Não foi possível ler os dados salvos neste navegador. O progresso local pode não estar disponível.",
      );
    } finally {
      setStorageLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!storageLoaded || authUser) return;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(guessedNames));
    } catch {
      setStorageError(
        "Não foi possível salvar seu progresso neste navegador. Suas respostas podem não persistir após recarregar.",
      );
    }
  }, [guessedNames, storageLoaded, authUser]);

  useEffect(() => {
    if (!supabase) return;
    let active = true;

    void supabase
      .from("conquistas")
      .select("id, titulo, descricao, icone, requisito_tipo, requisito_qtd")
      .order("requisito_qtd", { ascending: true })
      .then(
        ({ data, error }) => {
          if (!active) return;
          if (error) {
            setAchievementCatalogLoaded(true);
            setToast({
              id: ++toastSequenceRef.current,
              text: "Não foi possível carregar o catálogo de conquistas.",
              kind: "error",
            });
            return;
          }
          setAchievements(
            [...((data ?? []) as Achievement[])].sort((left, right) => {
              const leftIndex = achievementOrder.indexOf(left.titulo);
              const rightIndex = achievementOrder.indexOf(right.titulo);
              if (leftIndex === -1 && rightIndex === -1) {
                return left.requisito_qtd - right.requisito_qtd;
              }
              if (leftIndex === -1) return 1;
              if (rightIndex === -1) return -1;
              return leftIndex - rightIndex;
            }),
          );
          setAchievementCatalogLoaded(true);
        },
        () => {
          if (!active) return;
          setAchievementCatalogLoaded(true);
          setToast({
            id: ++toastSequenceRef.current,
            text: "Falha de conexão ao carregar o catálogo de conquistas.",
            kind: "error",
          });
        },
      );

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (
      !supabase ||
      !storageLoaded ||
      !authUser ||
      !achievementCatalogLoaded ||
      isLoading ||
      loadError
    ) {
      return;
    }
    const userId = authUser.id;
    if (
      syncingUserIdRef.current === userId ||
      syncedUserIdRef.current === userId
    ) {
      return;
    }

    syncingUserIdRef.current = userId;
    setAccountSyncing(true);
    void (async () => {
      try {
        const pendingNames = new Set([
          ...guessedNames,
          ...readStoredNames(STORAGE_KEY),
        ]);
        const pendingAchievementIds = readStoredNames(ACHIEVEMENTS_STORAGE_KEY);
        const { data: existingRows, error: existingError } = await supabase
          .from("usuario_acertos")
          .select("campeao_id, campeoes!inner(nome, id_riot)")
          .eq("user_id", userId);

        if (existingError) {
          throw new Error("Não foi possível buscar os acertos desta conta.");
        }

        const knownNames = new Set(
          (existingRows ?? []).flatMap((row) => {
            const relation = row.campeoes;
            const champion = Array.isArray(relation) ? relation[0] : relation;
            return champion?.nome ? [champion.nome as string] : [];
          }),
        );
        const pendingChampionRows = champions
          .filter(
            (champion) =>
              pendingNames.has(champion.nome) && !knownNames.has(champion.nome),
          )
          .map((champion) => ({
            id: crypto.randomUUID(),
            user_id: userId,
            campeao_id: champion.id,
          }));

        if (pendingChampionRows.length > 0) {
          const { error } = await supabase
            .from("usuario_acertos")
            .upsert(pendingChampionRows, {
              onConflict: "user_id,campeao_id",
              ignoreDuplicates: true,
            });
          if (error) {
            throw new Error("Não foi possível sincronizar os acertos locais.");
          }
        }

        let allPendingAchievementsValid = pendingAchievementIds.length === 0;
        if (pendingAchievementIds.length > 0) {
          const validAchievementIds = new Set(achievements.map(({ id }) => id));
          allPendingAchievementsValid = pendingAchievementIds.every((id) =>
            validAchievementIds.has(id),
          );
          const pendingAchievementRows = pendingAchievementIds
            .filter((id) => validAchievementIds.has(id))
            .map((conquista_id) => ({
              id: crypto.randomUUID(),
              user_id: userId,
              conquista_id,
            }));
          if (pendingAchievementRows.length > 0) {
            const { error } = await supabase
              .from("usuario_conquistas")
              .upsert(pendingAchievementRows, {
                onConflict: "user_id,conquista_id",
                ignoreDuplicates: true,
              });
            if (error) {
              throw new Error("Não foi possível sincronizar as conquistas locais.");
            }
          }
        }

        const { data: syncedRows, error: syncedError } = await supabase
          .from("usuario_acertos")
          .select("campeao_id, campeoes!inner(nome, id_riot)")
          .eq("user_id", userId);
        if (syncedError) {
          throw new Error("Não foi possível atualizar os acertos sincronizados.");
        }

        const accountNames = (syncedRows ?? []).flatMap((row) => {
          const relation = row.campeoes;
          const champion = Array.isArray(relation) ? relation[0] : relation;
          return champion?.nome ? [champion.nome as string] : [];
        });
        const { data: earnedRows, error: earnedError } = await supabase
          .from("usuario_conquistas")
          .select("conquista_id")
          .eq("user_id", userId);
        if (earnedError) {
          throw new Error("Não foi possível carregar as conquistas desta conta.");
        }

        const earnedIds = (earnedRows ?? []).map((row) => row.conquista_id);
        unlockedAchievementIdsRef.current = new Set(earnedIds);
        setUnlockedAchievementIds(earnedIds);
        setGuessedNames([...new Set(accountNames)]);
        localStorage.removeItem(STORAGE_KEY);
        if (allPendingAchievementsValid) {
          localStorage.removeItem(ACHIEVEMENTS_STORAGE_KEY);
        }
        syncedUserIdRef.current = userId;
        await evaluateAchievements(accountNames.length, crudActionCount);
      } catch (error) {
        setToast({
          id: ++toastSequenceRef.current,
          text:
            error instanceof Error
              ? error.message
              : "Falha inesperada ao sincronizar a conta.",
          kind: "error",
        });
      } finally {
        if (syncingUserIdRef.current === userId) {
          syncingUserIdRef.current = null;
          setAccountSyncing(false);
        }
      }
    })();
  }, [
    authUser,
    storageLoaded,
    isLoading,
    loadError,
    guessedNames,
    champions,
    achievements,
    achievementCatalogLoaded,
    crudActionCount,
  ]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    void getRiotCatalog()
      .then(setRiotCatalog)
      .catch((error: unknown) => {
        setRiotCatalogError(
          error instanceof Error
            ? error.message
            : "Não foi possível carregar os dados visuais do Data Dragon.",
        );
      });
  }, []);

  async function loadChampions() {
    if (!supabase) {
      setLoadError(
        "Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no arquivo .env para conectar ao Supabase.",
      );
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setLoadError("");
    const { data, error } = await supabase
      .from("campeoes")
      .select("id, nome, criado_em, id_riot")
      .order("nome", { ascending: true });

    if (error) {
      setChampions([]);
      setLoadError(
        "Não foi possível carregar os campeões. Verifique a conexão e as permissões do Supabase.",
      );
      setIsLoading(false);
      return;
    }

    setChampions(data ?? []);
    setIsLoading(false);
  }

  async function evaluateAchievements(
    acertosCount: number,
    currentCrudActionCount: number,
  ) {
    const newlyEarned = achievements.filter((achievement) => {
      if (unlockedAchievementIdsRef.current.has(achievement.id)) return false;
      if (achievement.requisito_tipo === "acertos_count") {
        return acertosCount >= achievement.requisito_qtd;
      }
      return (
        currentCrudActionCount >= achievement.requisito_qtd &&
        currentCrudActionCount > 0
      );
    });
    if (newlyEarned.length === 0) return;

    if (authUser && supabase) {
      try {
        const rows = newlyEarned.map(({ id }) => ({
          id: crypto.randomUUID(),
          user_id: authUser.id,
          conquista_id: id,
        }));
        const { error } = await supabase
          .from("usuario_conquistas")
          .upsert(rows, {
            onConflict: "user_id,conquista_id",
            ignoreDuplicates: true,
          });
        if (error) throw error;
      } catch {
        setToast({
          id: ++toastSequenceRef.current,
          text: "Não foi possível salvar uma conquista na sua conta.",
          kind: "error",
        });
        return;
      }
    } else {
      try {
        const storedIds = readStoredNames(ACHIEVEMENTS_STORAGE_KEY);
        const mergedIds = [
          ...new Set([...storedIds, ...newlyEarned.map(({ id }) => id)]),
        ];
        localStorage.setItem(
          ACHIEVEMENTS_STORAGE_KEY,
          JSON.stringify(mergedIds),
        );
      } catch {
        setStorageError(
          "Não foi possível salvar suas conquistas neste navegador.",
        );
        setToast({
          id: ++toastSequenceRef.current,
          text: "A conquista foi alcançada, mas não pôde ser salva neste navegador.",
          kind: "error",
        });
        return;
      }
    }

    const updatedIds = [
      ...unlockedAchievementIdsRef.current,
      ...newlyEarned.map(({ id }) => id),
    ];
    unlockedAchievementIdsRef.current = new Set(updatedIds);
    setUnlockedAchievementIds(updatedIds);
    setToast({
      id: ++toastSequenceRef.current,
      text: `✦ Conquista Desbloqueada: ${newlyEarned
        .map(({ titulo }) => titulo)
        .join(", ")}!`,
      kind: "success",
    });
  }

  async function registerCrudAchievement() {
    const nextCount = crudActionCount + 1;
    setCrudActionCount(nextCount);
    try {
      localStorage.setItem(CRUD_ACTIONS_STORAGE_KEY, String(nextCount));
    } catch {
      setStorageError(
        "Não foi possível salvar o progresso administrativo neste navegador.",
      );
    }
    await evaluateAchievements(guessedNames.length, nextCount);
  }

  useEffect(() => {
    void loadChampions();
  }, []);

  async function addGuess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A comparação é literal; só removemos espaços das bordas digitadas.
    const name = challengeInput.trim();

    if (!name) {
      setChallengeFeedback({
        kind: "error",
        text: "Digite o nome de um campeão antes de adicionar.",
      });
      return;
    }

    const champion = champions.find((item) => item.nome === name);
    if (!champion) {
      setChallengeFeedback({
        kind: "error",
        text: "Esse nome não existe no banco de campeões.",
      });
      return;
    }

    if (guessedSet.has(name)) {
      setChallengeFeedback({
        kind: "error",
        text: "Esse campeão já foi listado por você.",
      });
      return;
    }

    const nextNames = [...guessedNames, name];
    setGuessedNames(nextNames);
    setChallengeInput("");
    setChallengeFeedback({
      kind: "success",
      text: `${name} entrou para a sua lista!`,
    });

    if (authUser && supabase) {
      const { error } = await supabase.from("usuario_acertos").upsert(
        {
          id: crypto.randomUUID(),
          user_id: authUser.id,
          campeao_id: champion.id,
        },
        {
          onConflict: "user_id,campeao_id",
          ignoreDuplicates: true,
        },
      );
      if (error) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(nextNames));
        } catch {
          setStorageError("Não foi possível salvar o acerto pendente localmente.");
        }
        setToast({
          id: ++toastSequenceRef.current,
          text: "Acerto mantido nesta sessão, mas a sincronização falhou. Tente entrar novamente mais tarde.",
          kind: "error",
        });
        return;
      }
      await evaluateAchievements(nextNames.length, crudActionCount);
    }
  }

  function validateAdminName(value: string, currentId?: string): string | null {
    // Mantém acentos, apóstrofos e maiúsculas exatamente como foram informados.
    const name = value.trim();
    if (!name) return "O nome do campeão não pode ficar vazio.";
    if (Array.from(name).length > 100) {
      return "O nome deve ter no máximo 100 caracteres.";
    }
    if (
      champions.some(
        (champion) => champion.nome === name && champion.id !== currentId,
      )
    ) {
      return "Esse campeão já está no banco.";
    }
    return null;
  }

  async function addChampion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newChampion.trim();
    const validationError = validateAdminName(name);
    if (validationError) {
      setAdminFeedback({ kind: "error", text: validationError });
      return;
    }
    if (!supabase) return;

    setIsSaving(true);
    setAdminFeedback(null);
    const { error } = await supabase.from("campeoes").insert({ nome: name });
    setIsSaving(false);

    if (error) {
      setAdminFeedback({ kind: "error", text: errorMessage(error) });
      return;
    }

    setNewChampion("");
    setAdminFeedback({ kind: "success", text: `${name} foi adicionado.` });
    await registerCrudAchievement();
    await loadChampions();
  }

  async function findChampion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = adminSearch.trim();
    if (!name) {
      setAdminChampion(null);
      setAdminFeedback({ kind: "error", text: "Digite o nome para localizar um registro." });
      return;
    }
    if (!supabase) return;

    setIsSaving(true);
    setAdminFeedback(null);
    const { data, error } = await supabase
      .from("campeoes")
      .select("id, nome, criado_em, id_riot")
      .eq("nome", name)
      .maybeSingle();
    setIsSaving(false);

    if (error) {
      setAdminChampion(null);
      setAdminFeedback({
        kind: "error",
        text: "Não foi possível localizar o registro. Tente novamente.",
      });
      return;
    }
    if (!data) {
      setAdminChampion(null);
      setAdminFeedback({
        kind: "error",
        text: "Nenhum registro encontrado com esse nome.",
      });
      return;
    }

    setAdminChampion(data);
    setEditingName(data.nome);
    setAdminFeedback({ kind: "success", text: "Registro localizado." });
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adminChampion) return;
    const name = editingName.trim();
    const validationError = validateAdminName(name, adminChampion.id);
    if (validationError) {
      setAdminFeedback({ kind: "error", text: validationError });
      return;
    }
    if (!supabase) return;

    setIsSaving(true);
    setAdminFeedback(null);
    const { error } = await supabase
      .from("campeoes")
      .update({ nome: name })
      .eq("id", adminChampion.id);
    setIsSaving(false);

    if (error) {
      setAdminFeedback({ kind: "error", text: errorMessage(error) });
      return;
    }

    setAdminChampion(null);
    setAdminSearch("");
    setEditingName("");
    setAdminFeedback({ kind: "success", text: "Nome do campeão atualizado." });
    await registerCrudAchievement();
    await loadChampions();
  }

  async function deleteChampion() {
    if (!adminChampion) return;
    if (!window.confirm(`Deseja excluir ${adminChampion.nome} do banco?`)) {
      return;
    }
    if (!supabase) return;

    setIsSaving(true);
    setAdminFeedback(null);
    const { error } = await supabase
      .from("campeoes")
      .delete()
      .eq("id", adminChampion.id);
    setIsSaving(false);

    if (error) {
      setAdminFeedback({ kind: "error", text: errorMessage(error) });
      return;
    }

    setAdminChampion(null);
    setAdminSearch("");
    setEditingName("");
    setAdminFeedback({
      kind: "success",
      text: "O registro foi excluído.",
    });
    await registerCrudAchievement();
    await loadChampions();
  }

  function searchSafely(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = safeSearchInput.trim();
    if (!query) {
      setSafeSearchResult({
        kind: "error",
        text: "Digite uma letra ou trecho para pesquisar.",
      });
      return;
    }

    const normalizedQuery = query.toLocaleLowerCase("pt-BR");
    const exists = champions.some((champion) => {
      const normalizedName = champion.nome.toLocaleLowerCase("pt-BR");
      return safeSearchMode === "starts"
        ? normalizedName.startsWith(normalizedQuery)
        : normalizedName.includes(normalizedQuery);
    });

    setSafeSearchResult({
      kind: exists ? "success" : "error",
      text: exists
        ? "Sim, existe um campeão que corresponde à busca."
        : "Não, nenhum campeão corresponde à busca.",
    });
  }

  async function signOut() {
    if (!supabase) return;
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } catch {
      setToast({
        id: ++toastSequenceRef.current,
        text: "Não foi possível encerrar a sessão. Tente novamente.",
        kind: "error",
      });
    }
  }

  const progress = champions.length
    ? Math.min((guessedNames.length / champions.length) * 100, 100)
    : 0;

  return (
    <main className="site-shell">
      <div className="sky-glow sky-glow-left" aria-hidden="true" />
      <div className="sky-glow sky-glow-right" aria-hidden="true" />

      <header className="site-header">
        <a
          className="brand"
          href="#inicio"
          onClick={() => setActivePage("desafio")}
        >
          <span className="brand-mark" aria-hidden="true">✧</span>
          <span>VENTOS DE RUNETERRA</span>
        </a>
        <div className="header-actions">
          <nav className="page-tabs" aria-label="Navegação principal">
            <button
              className={activePage === "desafio" ? "tab active" : "tab"}
              onClick={() => setActivePage("desafio")}
              type="button"
            >
              O desafio
            </button>
            <button
              className={activePage === "admin" ? "tab active" : "tab"}
              onClick={() => setActivePage("admin")}
              type="button"
            >
              Campeões
            </button>
          </nav>
          <button
            className="header-utility"
            type="button"
            onClick={() => setShowAchievements(true)}
            aria-label={`Conquistas: ${unlockedAchievementIds.length} desbloqueadas`}
          >
            <span aria-hidden="true">✦</span>
            <span className="utility-label">Conquistas</span>
            <span className="utility-count">{unlockedAchievementIds.length}</span>
          </button>
          <div className="session-control">
            <span className="session-email" title={authUser.email ?? undefined}>
              {authUser.email ?? "Conta conectada"}
            </span>
            {accountSyncing && (
              <span className="sync-indicator" role="status">
                Sincronizando
              </span>
            )}
            <button
              className="header-utility signout-button"
              type="button"
              onClick={() => void signOut()}
            >
              Sair
            </button>
          </div>
        </div>
      </header>

      {activePage === "desafio" ? (
        <section className="challenge-page" aria-label="Desafio dos campeões">
          <aside className="challenge-sidebar">
            <section className="hero" id="inicio">
              <div className="hero-copy">
                <p className="eyebrow"><span /> A brisa que guia</p>
                <h1>Janna</h1>
                <p className="hero-subtitle">Guardiã dos Ventos</p>
              </div>
              <span className="hero-sigil" aria-hidden="true">✧</span>
            </section>

            <div className="journey-card glass-card" aria-label="Progresso do desafio">
              <div className="journey-copy">
                <p className="section-kicker">SUA JORNADA</p>
                <p className="progress-count">
                  <strong>{guessedNames.length}</strong>
                  <span> de {champions.length} campeões</span>
                </p>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Progresso de campeões encontrados"
                aria-valuemin={0}
                aria-valuemax={champions.length}
                aria-valuenow={Math.min(guessedNames.length, champions.length)}
              >
                <span style={{ width: `${progress}%` }} />
              </div>
            </div>
          </aside>

          <div className="challenge-content">
          <section className="challenge-card glass-card">
            <div className="challenge-title-row">
              <div className="heading-icon" aria-hidden="true">✧</div>
              <div>
                <p className="section-kicker">O DESAFIO</p>
                <h2>Liste todos os campeões</h2>
              </div>
            </div>
            <form className="guess-form" onSubmit={addGuess}>
              <label className="visually-hidden" htmlFor="champion-guess">
                Nome do campeão
              </label>
              <input
                id="champion-guess"
                type="text"
                value={challengeInput}
                onChange={(event) => setChallengeInput(event.target.value)}
                placeholder="Digite o nome de um campeão..."
                autoComplete="off"
                disabled={isLoading || Boolean(loadError)}
              />
              <button
                className="primary-button"
                type="submit"
                disabled={isLoading || Boolean(loadError)}
              >
                Adicionar <span aria-hidden="true">↗</span>
              </button>
            </form>
            <div className="feedback-slot" aria-live="polite">
              {challengeFeedback && (
                <p className={`feedback ${challengeFeedback.kind}`}>
                  <span aria-hidden="true">
                    {challengeFeedback.kind === "success" ? "✓" : "✕"}
                  </span>
                  {challengeFeedback.text}
                </p>
              )}
              {loadError && <p className="feedback error">{loadError}</p>}
              {isLoading && (
                <p className="muted-message">Carregando o desafio...</p>
              )}
            </div>
          </section>

          <section className="answers-section">
            <div className="list-heading">
              <div>
                <p className="section-kicker">SEUS ACERTOS</p>
                <h2>Campeões descobertos</h2>
              </div>
              <span className="count-pill">{guessedNames.length}</span>
            </div>
            {sortedGuesses.length > 0 ? (
              <ul className="answer-list">
                {sortedGuesses.map((name) => {
                  const champion = championByName.get(name);
                  const riotId =
                    champion?.id_riot ?? riotCatalog?.idsByName?.[name];
                  const title = riotId
                    ? riotCatalog?.titles?.[riotId] ?? name
                    : name;
                  const portraitUrl =
                    riotId && riotCatalog
                      ? `https://ddragon.leagueoflegends.com/cdn/${encodeURIComponent(riotCatalog.version)}/img/champion/${encodeURIComponent(riotId)}.png`
                      : null;

                  return (
                    <li className="answer-card" key={name} title={title}>
                      <span className="answer-check" aria-hidden="true">✓</span>
                      <span className="answer-name">{name}</span>
                      {portraitUrl ? (
                        <img
                          className="champion-portrait"
                          src={portraitUrl}
                          alt=""
                          loading="lazy"
                          onError={(event) => {
                            event.currentTarget.hidden = true;
                          }}
                        />
                      ) : (
                        <span className="portrait-placeholder" aria-hidden="true">
                          ✧
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="empty-state">
                <span aria-hidden="true">⌁</span>
                <p>O vento ainda não trouxe nomes...</p>
              </div>
            )}
            {riotCatalogError && (
              <p className="catalog-notice" role="status">
                {riotCatalogError} Seus acertos continuam salvos; os retratos
                aparecerão quando o catálogo estiver disponível.
              </p>
            )}
          </section>
          </div>
        </section>
      ) : (
        <section className="stats-page" aria-label="Estatísticas sem spoiler">
          <div className="stats-heading">
            <div>
              <p className="section-kicker">SANTUÁRIO DOS VENTOS</p>
              <h2>O mundo em números</h2>
              <p>Conheça Runeterra sem descobrir as respostas do desafio.</p>
            </div>
            <div className="total-card glass-card">
              <span className="total-sparkle" aria-hidden="true">✧</span>
              <strong>{champions.length}</strong>
              <span>campeões no banco</span>
            </div>
          </div>

          {loadError && <p className="feedback error">{loadError}</p>}
          {isLoading && <p className="muted-message">Carregando estatísticas...</p>}

          <div className="stats-grid">
            <section className="distribution-card glass-card">
              <div className="panel-heading">
                <div>
                  <p className="section-kicker">UM OLHAR AO ALFABETO</p>
                  <h3>Distribuição por inicial</h3>
                </div>
                <span className="panel-icon" aria-hidden="true">⌁</span>
              </div>
              {champions.length > 0 ? (
                <div className="letter-chart" aria-label="Distribuição relativa por letra inicial">
                  {letterDistribution.map(({ letter, count }) => (
                    <div className="letter-row" key={letter}>
                      <span className="letter-label">{letter}</span>
                      <div
                        className="letter-track"
                        role="img"
                        aria-label={`${letter}: ${count > 0 ? "há registros" : "sem registros"}`}
                      >
                        {count > 0 && (
                          <span
                            style={{
                              width: `${Math.max((count / largestLetterCount) * 100, 5)}%`,
                            }}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted-message">Sem dados para exibir.</p>
              )}
            </section>

            <section className="safe-search-card glass-card">
              <div className="panel-heading">
                <div>
                  <p className="section-kicker">SEM SPOILERS</p>
                  <h3>Uma busca segura</h3>
                </div>
                <span className="panel-icon" aria-hidden="true">⌕</span>
              </div>
              <p className="safe-search-description">
                Descubra apenas se há correspondência — sem nomes ou quantidades.
              </p>
              <form className="safe-search-form" onSubmit={searchSafely}>
                <label htmlFor="safe-search-mode">Quero saber se existe nome que</label>
                <select
                  id="safe-search-mode"
                  value={safeSearchMode}
                  onChange={(event) => {
                    setSafeSearchMode(event.target.value as "starts" | "contains");
                    setSafeSearchResult(null);
                  }}
                >
                  <option value="starts">começa com</option>
                  <option value="contains">contém</option>
                </select>
                <div className="guess-form">
                  <label className="visually-hidden" htmlFor="safe-search-query">
                    Letra ou trecho para busca
                  </label>
                  <input
                    id="safe-search-query"
                    value={safeSearchInput}
                    onChange={(event) => setSafeSearchInput(event.target.value)}
                    placeholder={safeSearchMode === "starts" ? "Uma letra" : "Um trecho"}
                    autoComplete="off"
                  />
                  <button className="primary-button" type="submit" disabled={isLoading}>
                    Consultar <span aria-hidden="true">↗</span>
                  </button>
                </div>
              </form>
              <div className="feedback-slot" aria-live="polite">
                {safeSearchResult && (
                  <p className={`feedback ${safeSearchResult.kind}`}>
                    <span aria-hidden="true">
                      {safeSearchResult.kind === "success" ? "✓" : "✕"}
                    </span>
                    {safeSearchResult.text}
                  </p>
                )}
              </div>
            </section>
          </div>

          <section className="admin-card glass-card">
            <div className="admin-intro">
              <div>
                <p className="section-kicker">ACESSO ADMINISTRATIVO</p>
                <h3>Gerenciar um campeão</h3>
                <p>Localize um registro pelo nome exato para editar ou excluir.</p>
              </div>
              <span className="admin-sigil" aria-hidden="true">✧</span>
            </div>

            <div className="admin-forms">
              <form className="admin-add-form" onSubmit={addChampion}>
                <label htmlFor="new-champion">Cadastrar novo campeão</label>
                <div className="guess-form">
                  <input
                    id="new-champion"
                    type="text"
                    maxLength={100}
                    value={newChampion}
                    onChange={(event) => setNewChampion(event.target.value)}
                    placeholder="Nome oficial em português"
                    disabled={isSaving || Boolean(loadError)}
                  />
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={isSaving || Boolean(loadError)}
                  >
                    {isSaving ? "Salvando..." : "Cadastrar"}{" "}
                    <span aria-hidden="true">+</span>
                  </button>
                </div>
              </form>

              <div className="admin-management">
                <form className="admin-lookup-form" onSubmit={findChampion}>
                  <label htmlFor="admin-search">
                    Editar ou excluir um registro
                  </label>
                  <div className="guess-form">
                    <input
                      id="admin-search"
                      value={adminSearch}
                      onChange={(event) => {
                        setAdminSearch(event.target.value);
                        setAdminChampion(null);
                        setAdminFeedback(null);
                      }}
                      placeholder="Digite o nome exato do campeão"
                      autoComplete="off"
                      disabled={isSaving || Boolean(loadError)}
                    />
                    <button
                      className="secondary-button"
                      type="submit"
                      disabled={isSaving || Boolean(loadError)}
                    >
                      Localizar <span aria-hidden="true">⌕</span>
                    </button>
                  </div>
                </form>

                {adminChampion && (
                  <form className="manage-record" onSubmit={saveEdit}>
                    <label htmlFor="edit-champion">
                      Registro localizado. Edite o nome ou exclua este campeão.
                    </label>
                    <div className="guess-form">
                      <input
                        id="edit-champion"
                        value={editingName}
                        maxLength={100}
                        onChange={(event) => setEditingName(event.target.value)}
                        disabled={isSaving}
                      />
                      <button
                        className="primary-button"
                        type="submit"
                        disabled={isSaving}
                      >
                        Salvar nome
                      </button>
                      <button
                        className="secondary-button delete-button"
                        type="button"
                        disabled={isSaving}
                        onClick={() => void deleteChampion()}
                      >
                        Excluir
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </div>

            <div className="feedback-slot admin-feedback" aria-live="polite">
              {adminFeedback && (
                <p className={`feedback ${adminFeedback.kind}`}>
                  <span aria-hidden="true">
                    {adminFeedback.kind === "success" ? "✓" : "✕"}
                  </span>
                  {adminFeedback.text}
                </p>
              )}
            </div>
          </section>
        </section>
      )}

      {storageError && (
        <div className="storage-notice" role="status">{storageError}</div>
      )}

      {showAchievements && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowAchievements(false);
            }
          }}
        >
          <section
            className="achievements-modal glass-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="achievements-title"
          >
            <div className="achievements-heading">
              <div>
                <p className="section-kicker">VENTOS DE RUNETERRA</p>
                <h2 id="achievements-title">Conquistas</h2>
                <p>
                  {unlockedAchievementIds.length} de {achievements.length} badges
                  desbloqueadas
                </p>
              </div>
              <button
                className="modal-close"
                type="button"
                aria-label="Fechar conquistas"
                onClick={() => setShowAchievements(false)}
              >
                ×
              </button>
            </div>
            {achievements.length > 0 ? (
              <div className="achievement-list">
                {achievements.map((achievement) => {
                  const unlocked = unlockedAchievementIds.includes(achievement.id);
                  return (
                    <article
                      className={
                        unlocked
                          ? "achievement-badge unlocked"
                          : "achievement-badge locked"
                      }
                      key={achievement.id}
                    >
                      <span className="badge-icon" aria-hidden="true">
                        {achievement.icone || "✦"}
                      </span>
                      <div className="badge-copy">
                        <h3>{achievement.titulo}</h3>
                        <p>{achievement.descricao}</p>
                      </div>
                      <span className="badge-status">
                        {unlocked ? "Desbloqueada" : "Bloqueada"}
                      </span>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="muted-message">
                {achievementCatalogLoaded
                  ? "Nenhuma conquista está cadastrada no catálogo."
                  : "Carregando conquistas..."}
              </p>
            )}
          </section>
        </div>
      )}

      {toast && (
        <div
          key={toast.id}
          className={`toast toast-${toast.kind}`}
          role={toast.kind === "error" ? "alert" : "status"}
          aria-live={toast.kind === "error" ? "assertive" : "polite"}
        >
          {toast.text}
        </div>
      )}

      <footer className="footer-runeterra site-footer">
        <span>✧</span> Soprado pelos ventos de Runeterra <span>✧</span>
      </footer>
    </main>
  );
}

function LandingPage({
  authError,
  isPasswordRecovery,
  onPasswordResetComplete,
}: {
  authError: string;
  isPasswordRecovery: boolean;
  onPasswordResetComplete: () => void;
}) {
  const [viewMode, setViewMode] = useState<AuthViewMode>(
    isPasswordRecovery ? "reset" : "login",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [signupConfirmationVisible, setSignupConfirmationVisible] =
    useState(false);
  const [newPasswordVisible, setNewPasswordVisible] = useState(false);
  const [resetConfirmationVisible, setResetConfirmationVisible] =
    useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [emailAlert, setEmailAlert] = useState<{
    title: string;
    message: string;
    role: "alert" | "status";
    canResend?: boolean;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResetFinishing, setIsResetFinishing] = useState(false);
  const [isResendingConfirmation, setIsResendingConfirmation] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (isPasswordRecovery) {
      setViewMode("reset");
      setFormError("");
      setNotice("");
      setEmailAlert(null);
    }
  }, [isPasswordRecovery]);

  useEffect(() => {
    if (resendCooldown === 0) return;
    const timer = window.setInterval(() => {
      setResendCooldown((remaining) => Math.max(0, remaining - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown]);

  function clearFeedback() {
    setFormError("");
    setNotice("");
    setEmailAlert(null);
  }

  function isRateLimitError(error: { code?: string; status?: number }) {
    return (
      error.status === 429 ||
      error.code === "over_request_rate_limit" ||
      error.code === "too_many_requests"
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearFeedback();

    if (!supabase) {
      setFormError("A conexão com o serviço de contas não está configurada.");
      return;
    }

    if (
      (viewMode === "login" || viewMode === "signup") &&
      password.length < 6
    ) {
      setFormError("A senha precisa ter no mínimo 6 caracteres.");
      return;
    }

    if (viewMode === "signup" && password !== confirmPassword) {
      setFormError("As senhas não coincidem.");
      return;
    }

    if (viewMode === "reset") {
      if (newPassword.length < 6) {
        setFormError("A nova senha precisa ter pelo menos 6 caracteres.");
        return;
      }
      if (newPassword !== confirmPassword) {
        setFormError("As senhas informadas não são iguais.");
        return;
      }
    }

    setIsSubmitting(true);
    try {
      if (viewMode === "login") {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) {
          console.error(
            "Erro detalhado do SignIn:",
            error.message,
            error.status,
          );
          if (
            error.message.includes("Email not confirmed") ||
            error.status === 422
          ) {
            setEmailAlert({
              title: "Confirmação necessária",
              message:
                "E-mail pendente de confirmação. Verifique sua caixa de entrada ou o painel de usuários.",
              role: "alert",
              canResend: true,
            });
          } else if (error.message.includes("Invalid login credentials")) {
            setFormError("E-mail ou senha incorretos.");
          } else {
            setFormError(error.message);
          }
        }
        return;
      }

      if (viewMode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        if (error) {
          console.error(
            "Erro detalhado do SignUp:",
            error.message,
            error.status,
          );
          setFormError(
            error.message === "User already registered" || error.status === 400
              ? "Este e-mail já está cadastrado. Tente entrar na aba 'Entrar' ou recupere sua senha."
              : error.message,
          );
          return;
        }

        if (data.session) {
          setNotice("Conta criada e conectada! Os ventos estão abrindo seu caminho...");
          return;
        }

        if (data.user && !data.session) {
          setPassword("");
          setConfirmPassword("");
          setViewMode("login");
          setEmailAlert({
            title: "Verifique seu e-mail!",
            message:
              "Enviamos um link de confirmação para sua caixa de entrada (e spam). Clique nele para ativar sua conta antes de entrar.",
            role: "status",
            canResend: true,
          });
          return;
        }

        setNotice("Conta criada! Os ventos estão abrindo seu caminho...");
        return;
      }

      if (viewMode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(
          email.trim(),
          { redirectTo: window.location.origin },
        );
        if (error) {
          setFormError(
            isRateLimitError(error)
              ? "⚠️ Limite de requisições temporariamente atingido. Aguarde alguns instantes."
              : "Não foi possível enviar o link. Confira o e-mail e tente novamente.",
          );
          return;
        }
        setNotice(
          "Link de redefinição enviado para o e-mail, verifique sua caixa de entrada e a pasta de spam.",
        );
        return;
      }

      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (error) {
        setFormError(
          isRateLimitError(error)
            ? "⚠️ Limite de requisições temporariamente atingido. Aguarde alguns instantes."
            : "Não foi possível atualizar a senha. Abra novamente o link recebido e tente de novo.",
        );
        return;
      }

      setNotice("Senha redefinida com sucesso! Abrindo sua jornada...");
      setIsResetFinishing(true);
      window.setTimeout(onPasswordResetComplete, 1400);
    } catch (error) {
      console.error("Erro inesperado na autenticação do Supabase:", error);
      setFormError("Falha de conexão. Verifique sua internet e tente novamente.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function resendConfirmationEmail() {
    if (!supabase || !email.trim() || resendCooldown > 0) return;

    setIsResendingConfirmation(true);
    setFormError("");
    try {
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: email.trim(),
      });
      if (error) {
        console.error("Erro ao reenviar confirmação do e-mail:", error);
        setFormError(
          isRateLimitError(error)
            ? "Limite de requisições atingido. Aguarde antes de tentar novamente."
            : error.message,
        );
        return;
      }

      setEmailAlert({
        title: "E-mail de ativação reenviado",
        message: "Novo e-mail de ativação enviado com sucesso!",
        role: "status",
        canResend: true,
      });
      setResendCooldown(60);
    } catch (error) {
      console.error("Falha ao reenviar confirmação do e-mail:", error);
      setFormError("Não foi possível reenviar o e-mail. Tente novamente.");
    } finally {
      setIsResendingConfirmation(false);
    }
  }

  const titleByMode: Record<AuthViewMode, string> = {
    login: "Boas-vindas",
    signup: "Crie sua conta",
    forgot: "Recuperar acesso",
    reset: "Nova senha",
  };
  const isPasswordView = viewMode === "login" || viewMode === "signup";

  return (
    <main className="site-shell landing-shell auth-container">
      <div className="sky-glow sky-glow-left" aria-hidden="true" />
      <div className="sky-glow sky-glow-right" aria-hidden="true" />
      <section className="landing-layout" aria-label="Apresentação e acesso">
        <div className="landing-intro">
          <div className="landing-wordmark">
            <span aria-hidden="true">✦</span>
            <span>VENTOS DE RUNETERRA</span>
          </div>
          <p className="landing-eyebrow">GUARDIÃ DOS VENTOS</p>
          <h1>Que a brisa guie sua jornada.</h1>
          <p className="landing-description">
            Bem-vindo a Runeterra. Teste seu conhecimento, liste os 173
            campeões oficiais e descubra até onde os ventos podem levar você.
          </p>
          <div className="landing-highlights">
            <article className="highlight-card">
              <span aria-hidden="true">✦</span>
              <p>173 Campeões Oficiais</p>
            </article>
            <article className="highlight-card">
              <span aria-hidden="true">✦</span>
              <p>Conquistas Temáticas Exclusivas</p>
            </article>
            <article className="highlight-card">
              <span aria-hidden="true">✦</span>
              <p>Progresso Sincronizado na Nuvem</p>
            </article>
          </div>
          <div className="landing-decoration" aria-hidden="true">
            <span className="landing-orbit orbit-a" />
            <span className="landing-orbit orbit-b" />
            <span className="landing-orbit-core">✧</span>
          </div>
        </div>

        <section className="landing-auth glass-card" aria-label="Acesse sua conta">
          <p className="section-kicker">
            {viewMode === "reset"
              ? "RECUPERAÇÃO SEGURA"
              : "SUA JORNADA COMEÇA AQUI"}
          </p>
          <h2>{titleByMode[viewMode]}</h2>
          <p className="auth-intro-copy">
            {viewMode === "forgot"
              ? "Informe o e-mail da sua conta para receber um link de recuperação."
              : viewMode === "reset"
                ? "Escolha uma nova senha para voltar à sua jornada."
                : "Conecte-se para salvar seu progresso e suas conquistas."}
          </p>

          {emailAlert && (
            <div
              className="auth-alert-banner"
              role={emailAlert.role}
              aria-live="polite"
            >
              <span className="auth-alert-icon" aria-hidden="true">
                ✉
              </span>
              <div>
                <strong>{emailAlert.title}</strong>
                <p>{emailAlert.message}</p>
                {emailAlert.canResend && (
                  <button
                    className="auth-resend-link"
                    type="button"
                    onClick={() => void resendConfirmationEmail()}
                    disabled={
                      isResendingConfirmation ||
                      resendCooldown > 0 ||
                      !email.trim()
                    }
                  >
                    {isResendingConfirmation
                      ? "Reenviando..."
                      : resendCooldown > 0
                        ? `Reenviar e-mail (${resendCooldown}s)`
                        : "Reenviar e-mail de confirmação"}
                  </button>
                )}
              </div>
            </div>
          )}

          {viewMode !== "forgot" && viewMode !== "reset" && (
            <div className="auth-tabs" role="tablist" aria-label="Acesso à conta">
              <button
                className={viewMode === "login" ? "auth-tab active" : "auth-tab"}
                type="button"
                role="tab"
                aria-selected={viewMode === "login"}
                onClick={() => {
                  setViewMode("login");
                  clearFeedback();
                }}
              >
                Entrar
              </button>
              <button
                className={viewMode === "signup" ? "auth-tab active" : "auth-tab"}
                type="button"
                role="tab"
                aria-selected={viewMode === "signup"}
                onClick={() => {
                  setViewMode("signup");
                  clearFeedback();
                }}
              >
                Criar Conta
              </button>
            </div>
          )}

          {notice && (
            <div className="auth-success-banner" role="status" aria-live="polite">
              <span aria-hidden="true">✦</span>
              <p>{notice}</p>
            </div>
          )}

          <form className="landing-form" onSubmit={submit}>
            {viewMode !== "reset" && (
              <>
                <label htmlFor="landing-email">E-mail</label>
                <input
                  id="landing-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="voce@exemplo.com"
                  disabled={isSubmitting || !supabase}
                />
              </>
            )}

            {isPasswordView && (
              <>
                <label htmlFor="landing-password">Senha</label>
                <div className="password-field">
                  <input
                    id="landing-password"
                    type={passwordVisible ? "text" : "password"}
                    autoComplete={
                      viewMode === "signup"
                        ? "new-password"
                        : "current-password"
                    }
                    minLength={6}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Pelo menos 6 caracteres"
                    disabled={isSubmitting || !supabase}
                  />
                  <button
                    className="password-visibility"
                    type="button"
                    aria-label={passwordVisible ? "Ocultar senha" : "Mostrar senha"}
                    aria-pressed={passwordVisible}
                    onClick={() => setPasswordVisible((visible) => !visible)}
                  >
                    {passwordVisible ? "Ocultar" : "Mostrar"}
                  </button>
                </div>
                {viewMode === "signup" && (
                  <>
                    <label htmlFor="signup-confirm-password">
                      Confirmar Senha
                    </label>
                    <div className="password-field">
                      <input
                        id="signup-confirm-password"
                        type={
                          signupConfirmationVisible ? "text" : "password"
                        }
                        autoComplete="new-password"
                        minLength={6}
                        required
                        value={confirmPassword}
                        onChange={(event) =>
                          setConfirmPassword(event.target.value)
                        }
                        placeholder="Digite a senha novamente"
                        disabled={isSubmitting || !supabase}
                      />
                      <button
                        className="password-visibility"
                        type="button"
                        aria-label={
                          signupConfirmationVisible
                            ? "Ocultar confirmação de senha"
                            : "Mostrar confirmação de senha"
                        }
                        aria-pressed={signupConfirmationVisible}
                        onClick={() =>
                          setSignupConfirmationVisible((visible) => !visible)
                        }
                      >
                        {signupConfirmationVisible ? "Ocultar" : "Mostrar"}
                      </button>
                    </div>
                  </>
                )}
                {viewMode === "login" && (
                  <button
                    className="auth-text-link"
                    type="button"
                    onClick={() => {
                      setViewMode("forgot");
                      clearFeedback();
                    }}
                  >
                    Esqueceu sua senha?
                  </button>
                )}
              </>
            )}

            {viewMode === "reset" && (
              <>
                <label htmlFor="new-password">Nova senha</label>
                <div className="password-field">
                  <input
                    id="new-password"
                    type={newPasswordVisible ? "text" : "password"}
                    autoComplete="new-password"
                    minLength={6}
                    required
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    placeholder="Pelo menos 6 caracteres"
                    disabled={isSubmitting || !supabase}
                  />
                  <button
                    className="password-visibility"
                    type="button"
                    aria-label={
                      newPasswordVisible ? "Ocultar nova senha" : "Mostrar nova senha"
                    }
                    aria-pressed={newPasswordVisible}
                    onClick={() => setNewPasswordVisible((visible) => !visible)}
                  >
                    {newPasswordVisible ? "Ocultar" : "Mostrar"}
                  </button>
                </div>
                <label htmlFor="confirm-password">Confirme a nova senha</label>
                <div className="password-field">
                  <input
                    id="confirm-password"
                    type={
                      resetConfirmationVisible ? "text" : "password"
                    }
                    autoComplete="new-password"
                    minLength={6}
                    required
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="Digite a senha novamente"
                    disabled={isSubmitting || !supabase}
                  />
                  <button
                    className="password-visibility"
                    type="button"
                    aria-label={
                      resetConfirmationVisible
                        ? "Ocultar confirmação de senha"
                        : "Mostrar confirmação de senha"
                    }
                    aria-pressed={resetConfirmationVisible}
                    onClick={() =>
                      setResetConfirmationVisible((visible) => !visible)
                    }
                  >
                    {resetConfirmationVisible ? "Ocultar" : "Mostrar"}
                  </button>
                </div>
              </>
            )}

            {(formError || authError) && (
              <p className="landing-message error" role="alert">
                {formError || authError}
              </p>
            )}

            <button
              className="primary-button landing-submit"
              type="submit"
              disabled={
                isSubmitting || isResetFinishing || !supabase
              }
            >
              {isSubmitting
                ? "Invocando..."
                : viewMode === "login"
                  ? "Invocar Ventos (Entrar)"
                  : viewMode === "signup"
                    ? "Criar minha conta"
                    : viewMode === "forgot"
                      ? "Enviar link de recuperação"
                      : "Salvar nova senha"}
              {!isSubmitting && <span aria-hidden="true">↗</span>}
            </button>
          </form>

          {viewMode === "forgot" && (
            <button
              className="auth-text-link auth-back-link"
              type="button"
              onClick={() => {
                setViewMode("login");
                clearFeedback();
              }}
            >
              ← Voltar ao login
            </button>
          )}

          {viewMode === "reset" && (
            <p className="landing-note">
              ✧ Esta página só pode ser acessada pelo link de recuperação enviado ao seu e-mail.
            </p>
          )}

          {viewMode !== "reset" && (
            <p className="landing-note">
              ✧ Seu progresso fica protegido e sincronizado com sua conta.
            </p>
          )}
        </section>
      </section>
      <footer className="footer-runeterra site-footer">
        <span>✦</span> Soprado pelos ventos de Runeterra <span>✦</span>
      </footer>
    </main>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState("");
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setAuthError(
        "Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY para acessar sua conta.",
      );
      setLoadingAuth(false);
      return;
    }

    let active = true;
    let authEventVersion = 0;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      authEventVersion += 1;
      setSession(nextSession);
      if (event === "PASSWORD_RECOVERY") {
        setIsPasswordRecovery(true);
      }
      setAuthError("");
      setLoadingAuth(false);
    });
    const versionAtSessionRequest = authEventVersion;

    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setAuthError("Não foi possível verificar sua sessão. Tente novamente.");
        }
        if (authEventVersion === versionAtSessionRequest) {
          setSession(data.session);
        }
      })
      .catch(() => {
        if (!active) return;
        setAuthError("Falha ao verificar sua sessão. Recarregue a página.");
      })
      .finally(() => {
        if (active) setLoadingAuth(false);
      });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (
      !supabase ||
      !session ||
      session.user.email_confirmed_at ||
      isPasswordRecovery
    ) {
      return;
    }

    let active = true;
    void supabase.auth
      .signOut()
      .then(({ error }) => {
        if (!active) return;
        setAuthError(
          error
            ? "Esta conta precisa confirmar o e-mail antes de acessar o desafio. Saia e entre novamente após confirmar."
            : "E-mail não confirmado. Verifique sua caixa de entrada e confirme a conta antes de acessar o desafio.",
        );
      })
      .catch(() => {
        if (active) {
          setAuthError(
            "Não foi possível encerrar a sessão não confirmada. Tente novamente.",
          );
        }
      });

    return () => {
      active = false;
    };
  }, [session, isPasswordRecovery]);

  if (loadingAuth) {
    return (
      <main className="auth-loading">
        <span className="loading-sigil" aria-hidden="true">✧</span>
        <p>Os ventos estão soprando...</p>
      </main>
    );
  }

  if (!session || isPasswordRecovery || !session.user.email_confirmed_at) {
    return (
      <LandingPage
        authError={authError}
        isPasswordRecovery={isPasswordRecovery}
        onPasswordResetComplete={() => setIsPasswordRecovery(false)}
      />
    );
  }

  return <DesafioApp key={session.user.id} user={session.user} />;
}

export default App;
