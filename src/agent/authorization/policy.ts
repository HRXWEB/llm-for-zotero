import type {
  ActionConstraint,
  ActionDomain,
  ActionEffect,
  ActionMechanism,
  ActionProposal,
  AuthorizationDecision,
  OriginalAuthorizationContext,
} from "./types";

const PROHIBITION = String.raw`(?:do\s+not|don't|dont|never|must\s+not|no)`;
const LIBRARY_MUTATION = [
  new RegExp(
    String.raw`\b${PROHIBITION}\b[^.!?\n]{0,80}\b(?:change|modify|edit|write|delete|remove|create|save|update|mutate)\b[^.!?\n]{0,60}\b(?:library|zotero|items?|papers?|notes?|collections?|tags?|metadata)\b|\b${PROHIBITION}\b[^.!?\n]{0,40}\b(?:library|zotero|items?|papers?|notes?|collections?|tags?|metadata)\b[^.!?\n]{0,60}\b(?:change|modify|edit|write|delete|remove|create|save|update|mutate)\b`,
    "i",
  ),
  /(?:不要|不准|不可|不能|禁止|请勿|請勿|切勿)[^。！？.!?\n]{0,40}(?:更改|修改|编辑|編輯|写入|寫入|删除|刪除|移除|创建|創建|建立|保存|儲存|更新|添加|新增)[^。！？.!?\n]{0,30}(?:zotero|文库|文庫|资料库|資料庫|图书馆|圖書館|条目|條目|论文|論文|笔记|筆記|收藏夹|收藏夾|集合|分类|分類|标签|標籤)|(?:不要|不准|不可|不能|禁止|请勿|請勿|切勿)[^。！？.!?\n]{0,30}(?:zotero|文库|文庫|资料库|資料庫|图书馆|圖書館|条目|條目|论文|論文|笔记|筆記|收藏夹|收藏夾|集合|分类|分類|标签|標籤)[^。！？.!?\n]{0,40}(?:更改|修改|编辑|編輯|写入|寫入|删除|刪除|移除|创建|創建|建立|保存|儲存|更新|添加|新增)/i,
  /(?:zotero|ライブラリ|項目|論文|ノート|コレクション|タグ|メタデータ)[^。！？.!?\n]{0,40}(?:変更|編集|書き込|削除|作成|保存|更新|追加)[^。！？.!?\n]{0,16}(?:しない|しないで|するな|禁止)/i,
  /\b(?:no|nunca)\b[^.!?\n]{0,30}\b(?:cambies|modifiques|edites|escribas|borres|elimines|crees|guardes|actualices)\b[^.!?\n]{0,60}\b(?:biblioteca|zotero|elementos?|art[ií]culos?|notas?|colecciones?|etiquetas?|metadatos?)\b/i,
];
const GENERIC_MUTATION = [
  new RegExp(
    String.raw`\b${PROHIBITION}\b[^.!?\n]{0,30}\b(?:change|modify|edit|write|delete|remove|create|save|update|mutate)\s+(?:anything|files?|data|state)\b`,
    "i",
  ),
  /(?:不要|不准|不可|不能|禁止|请勿|請勿|切勿)[^。！？.!?\n]{0,30}(?:更改|修改|编辑|編輯|写入|寫入|删除|刪除|移除|创建|創建|建立|保存|儲存|更新)[^。！？.!?\n]{0,20}(?:任何|任意)?(?:内容|內容|东西|東西|文件|檔案|数据|資料|状态|狀態)/i,
  /(?:何も|ファイル|データ|状態)[^。！？.!?\n]{0,30}(?:変更|編集|書き込|削除|作成|保存|更新)[^。！？.!?\n]{0,16}(?:しない|しないで|するな|禁止)/i,
  /\b(?:no|nunca)\b[^.!?\n]{0,30}\b(?:cambies|modifiques|edites|escribas|borres|elimines|crees|guardes|actualices)\b[^.!?\n]{0,30}\b(?:nada|archivos?|datos?|estado)\b/i,
];
const EXECUTION = [
  new RegExp(
    String.raw`\b${PROHIBITION}\b[^.!?\n]{0,30}\b(?:run|execute|launch)\b(?:[^.!?\n]{0,30}\b(?:commands?|scripts?|programs?|tests?|builds?)\b)?`,
    "i",
  ),
  /(?:不要|不准|不可|不能|禁止|请勿|請勿|切勿)[^。！？.!?\n]{0,30}(?:运行|運行|执行|執行|启动|啟動)(?:[^。！？.!?\n]{0,20}(?:命令|指令|脚本|腳本|程序|测试|測試|构建|建置))?/i,
  /(?:コマンド|スクリプト|プログラム|テスト|ビルド)[^。！？.!?\n]{0,24}(?:実行|起動)[^。！？.!?\n]{0,16}(?:しない|しないで|するな|禁止)|(?:実行|起動)[^。！？.!?\n]{0,12}(?:しない|しないで|するな|禁止)/i,
  /\b(?:no|nunca)\b[^.!?\n]{0,30}\b(?:ejecutes?|lances?|inicies?)\b(?:[^.!?\n]{0,30}\b(?:comandos?|scripts?|programas?|pruebas?|compilaciones?)\b)?/i,
];
const EGRESS = [
  new RegExp(
    String.raw`\b${PROHIBITION}\b[^.!?\n]{0,50}\b(?:upload|share|send|transmit|post|publish|network(?:\s+requests?)?|external\s+requests?|egress)\b`,
    "i",
  ),
  /(?:不要|不准|不可|不能|禁止|请勿|請勿|切勿)[^。！？.!?\n]{0,40}(?:上传|上傳|分享|发送|發送|传送|傳送|发布|發佈|联网|聯網|网络请求|網路請求|外部请求|外部請求)/i,
  /(?:アップロード|共有|送信|投稿|公開|ネットワーク接続)[^。！？.!?\n]{0,16}(?:しない|しないで|するな|禁止)/i,
  /\b(?:no|nunca)\b[^.!?\n]{0,30}\b(?:subas|compartas|env[ií]es|transmitas|publiques)\b/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function withoutRelativeMutationExclusions(text: string): string {
  return text
    .replace(
      new RegExp(
        String.raw`\b${PROHIBITION}\b[^.!?\n]{0,30}\b(?:change|modify|edit|delete|remove|update)\b[^.!?\n]{0,20}\b(?:other|unrelated)\s+(?:items?|papers?|notes?|collections?|tags?|metadata)\b`,
        "gi",
      ),
      "",
    )
    .replace(
      /(?:不要|不准|不可|不能|禁止|请勿|請勿|切勿)[^。！？.!?\n]{0,24}(?:更改|修改|编辑|編輯|删除|刪除|移除|更新)[^。！？.!?\n]{0,16}(?:其他|其它|其余|其餘|别的|別的)(?:条目|條目|论文|論文|笔记|筆記|收藏夹|收藏夾|集合|分类|分類|标签|標籤)/gi,
      "",
    )
    .replace(
      /(?:他の|別の|無関係な)(?:項目|論文|ノート|コレクション|タグ|メタデータ)[^。！？.!?\n]{0,30}(?:変更|編集|削除|更新)[^。！？.!?\n]{0,16}(?:しない|しないで|するな|禁止)/gi,
      "",
    )
    .replace(
      /\b(?:no|nunca)\b[^.!?\n]{0,30}\b(?:cambies|modifiques|edites|borres|elimines|actualices)\b[^.!?\n]{0,20}\b(?:otros?|otras?)\s+(?:elementos?|art[ií]culos?|notas?|colecciones?|etiquetas?|metadatos?)\b/gi,
      "",
    );
}

function constraint(
  effects: ActionEffect[],
  domains: ActionDomain[],
  description: string,
): ActionConstraint {
  return { kind: "deny_effects", effects, domains, description };
}

function mechanismConstraint(
  mechanisms: Exclude<ActionMechanism, "none">[],
  description: string,
): ActionConstraint {
  return { kind: "deny_mechanisms", mechanisms, description };
}

export function parseActionConstraints(userText: string): ActionConstraint[] {
  const constraints: ActionConstraint[] = [];
  const globalMutationText = withoutRelativeMutationExclusions(userText);
  if (matchesAny(globalMutationText, LIBRARY_MUTATION)) {
    constraints.push(
      constraint(
        ["create", "modify", "delete"],
        ["zotero_library", "privileged_zotero"],
        "The user prohibited mutations to the Zotero library.",
      ),
    );
  } else if (matchesAny(globalMutationText, GENERIC_MUTATION)) {
    constraints.push(
      constraint(
        ["create", "modify", "delete"],
        ["zotero_library", "privileged_zotero", "filesystem"],
        "The user prohibited persistent state changes.",
      ),
    );
  }
  if (matchesAny(userText, EXECUTION)) {
    constraints.push(
      mechanismConstraint(
        ["shell", "zotero_script"],
        "The user prohibited commands and scripts from executing.",
      ),
    );
  }
  if (matchesAny(userText, EGRESS)) {
    constraints.push(
      constraint(
        ["egress"],
        ["network"],
        "The user prohibited external network egress.",
      ),
    );
  }
  return constraints;
}

export function hasExplicitNoWriteConstraint(userText: string): boolean {
  return parseActionConstraints(userText).some(
    (entry) =>
      entry.kind === "deny_effects" &&
      entry.effects.some((effect) =>
        ["create", "modify", "delete"].includes(effect),
      ),
  );
}

export function proposalViolatesConstraints(
  proposal: Pick<ActionProposal, "domains" | "effects" | "invocationPlan">,
  constraints: readonly ActionConstraint[],
): ActionConstraint | null {
  return (
    constraints.find((constraint) => {
      if (constraint.kind === "deny_mechanisms") {
        return (
          proposal.invocationPlan.mechanism !== "none" &&
          constraint.mechanisms.includes(proposal.invocationPlan.mechanism)
        );
      }
      return (
        proposal.domains.some((domain) =>
          constraint.domains.includes(domain),
        ) &&
        proposal.effects.some((effect) => constraint.effects.includes(effect))
      );
    }) || null
  );
}

export function normalizeStoredActionConstraints(
  constraints:
    | readonly (ActionConstraint | { kind: "no_write"; description: string })[]
    | undefined,
): ActionConstraint[] {
  return (constraints || []).flatMap((entry) => {
    if (entry.kind === "deny_mechanisms") return [entry];
    if (entry.kind === "deny_effects") {
      const executeDenied = entry.effects.includes("execute");
      const effects = entry.effects.filter((effect) => effect !== "execute");
      return [
        ...(effects.length ? [{ ...entry, effects }] : []),
        ...(executeDenied
          ? [mechanismConstraint(["shell", "zotero_script"], entry.description)]
          : []),
      ];
    }
    return [
      constraint(
        ["create", "modify", "delete"],
        [
          "zotero_library",
          "filesystem",
          "local_execution",
          "privileged_zotero",
        ],
        entry.description,
      ),
      mechanismConstraint(["shell", "zotero_script"], entry.description),
    ];
  });
}

export function authorizeOriginalAction(
  proposal: ActionProposal,
  context: OriginalAuthorizationContext,
): AuthorizationDecision {
  const legacyConstraints =
    context.hasExplicitNoWrite && !context.constraints?.length
      ? [
          constraint(
            ["create", "modify", "delete"],
            [
              "zotero_library",
              "filesystem",
              "local_execution",
              "privileged_zotero",
            ],
            "The user's request explicitly prohibits changing or executing anything.",
          ),
        ]
      : [];
  const violation = proposalViolatesConstraints(proposal, [
    ...(context.constraints || []),
    ...legacyConstraints,
  ]);
  if (violation) {
    return {
      kind: "block",
      reason: violation.description,
    };
  }
  if (
    proposal.invocationPlan.impact === "prohibited" ||
    proposal.riskSignals.includes("protected_target") ||
    proposal.riskSignals.includes("raw_database") ||
    proposal.riskSignals.includes("authorization_tampering")
  ) {
    return {
      kind: "block",
      reason: "The proposed action targets a protected integrity boundary.",
    };
  }
  const trustedRead =
    proposal.invocationPlan.impact === "read_only" &&
    proposal.invocationPlan.assurance !== "unknown";
  if (trustedRead) {
    return { kind: "execute", authority: "safe_read" };
  }
  if (context.mode === "safe") {
    return {
      kind: "confirm",
      reason: "Safe mode reviews this action before it runs.",
    };
  }
  if (context.mode === "yolo") {
    return { kind: "execute", authority: "yolo" };
  }
  const exceptionalDanger = proposal.riskSignals.some((signal) =>
    [
      "ambiguous_target",
      "scope_expansion",
      "sensitive_egress",
      "broad_delete",
      "privilege_escalation",
      "package_system_modification",
      "download_to_shell",
    ].includes(signal),
  );
  if (exceptionalDanger) {
    return {
      kind: "confirm",
      reason:
        "Auto mode found genuine ambiguity or exceptional danger in the exact action.",
    };
  }
  if (context.hasMatchingActionIntent) {
    return { kind: "execute", authority: "auto_policy" };
  }
  if (proposal.invocationPlan.impact === "ambiguous") {
    return { kind: "execute", authority: "auto_policy" };
  }
  const intentPatterns = proposal.domains.includes("local_execution")
    ? [
        /\b(?:run|execute|command|shell|terminal|script|test|build|install|analy[sz]e|compute|calculate|convert)\b/i,
        /(?:运行|運行|执行|執行|启动|啟動|命令|指令|脚本|腳本|测试|測試|构建|建置|安装|安裝|分析|计算|計算|转换|轉換)/i,
        /(?:実行|起動|コマンド|シェル|スクリプト|テスト|ビルド|インストール|分析|計算|変換)/i,
        /\b(?:ejecuta|ejecutar|comando|shell|terminal|script|prueba|compila|instala|analiza|calcula|convierte)\b/i,
      ]
    : proposal.domains.includes("privileged_zotero")
      ? [
          /\b(?:run|execute|script|analy[sz]e|compute|calculate|change|modify|edit|update|write|delete|create)\b/i,
          /(?:运行|運行|执行|執行|脚本|腳本|分析|计算|計算|更改|修改|编辑|編輯|更新|写入|寫入|删除|刪除|创建|創建|建立)/i,
          /(?:実行|スクリプト|分析|計算|変更|編集|更新|書き込|削除|作成)/i,
          /\b(?:ejecuta|script|analiza|calcula|cambia|modifica|edita|actualiza|escribe|elimina|crea)\b/i,
        ]
      : proposal.domains.includes("filesystem")
        ? [
            /\b(?:read|open|inspect|write|save|create|edit|change|modify|delete|remove|move|copy|file|folder|directory)\b/i,
            /(?:读取|讀取|打开|打開|查看|检查|檢查|写入|寫入|保存|儲存|创建|創建|建立|编辑|編輯|修改|删除|刪除|移动|移動|复制|複製|文件|檔案|文件夹|資料夾|目录|目錄)/i,
            /(?:読|開|確認|書き込|保存|作成|編集|変更|削除|移動|コピー|ファイル|フォルダ|ディレクトリ)/i,
            /\b(?:lee|abre|inspecciona|escribe|guarda|crea|edita|cambia|modifica|elimina|mueve|copia|archivo|carpeta|directorio)\b/i,
          ]
        : proposal.domains.includes("network")
          ? [
              /\b(?:search|research|investigate|find|look\s+up|browse|web|online|current|latest|news|fact|fetch|download|upload|request|url|page)\b/i,
              /(?:搜索|搜尋|研究|调查|調查|查找|查詢|浏览|瀏覽|网络|網路|在线|線上|最新|新闻|新聞|下载|下載|上传|上傳|请求|請求|网页|網頁)/i,
              /(?:検索|調査|探す|閲覧|ウェブ|オンライン|最新|ニュース|取得|ダウンロード|アップロード|リクエスト|ページ)/i,
              /\b(?:busca|investiga|encuentra|consulta|navega|web|internet|actual|[uú]ltim[oa]|noticias|descarga|sube|solicitud|p[aá]gina)\b/i,
            ]
          : [
              /\b(?:add|apply|change|create|delete|edit|file|import|merge|modify|move|remove|rename|restore|save|set|tag|trash|update|write|fix)\b/i,
              /(?:添加|新增|应用|應用|更改|修改|创建|創建|建立|删除|刪除|编辑|編輯|归档|歸檔|导入|匯入|合并|合併|移动|移動|移除|重命名|重新命名|恢复|還原|保存|儲存|设置|設定|标签|標籤|回收站|更新|写入|寫入|修正|笔记|筆記)/i,
              /(?:追加|適用|変更|作成|削除|編集|整理|インポート|統合|移動|除去|名前変更|復元|保存|設定|タグ|ゴミ箱|更新|書き込|修正|ノート)/i,
              /\b(?:agrega|aplica|cambia|crea|elimina|edita|archiva|importa|combina|modifica|mueve|quita|renombra|restaura|guarda|establece|etiqueta|papelera|actualiza|escribe|corrige|nota)\b/i,
            ];
  if (!matchesAny(context.userText, intentPatterns)) {
    return {
      kind: "confirm",
      reason:
        "Auto mode could not map the proposed effect to a clear action in the user's request.",
    };
  }
  return { kind: "execute", authority: "auto_policy" };
}
