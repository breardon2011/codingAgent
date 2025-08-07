interface ConversationEntry {
  id: string;
  timestamp: Date;
  userInput: string;
  intent: any;
  searchResults?: any[];
  proposal?: any;
  outcome: "accepted" | "rejected" | "modified" | "error";
  finalChange?: any;
  context?: string;
}

interface ProjectContext {
  recentChanges: ConversationEntry[];
  fileModifications: Map<string, { count: number; lastModified: Date }>;
  commonPatterns: string[];
  userPreferences: {
    preferredActions: string[];
    rejectionReasons: string[];
  };
}

class ConversationHistory {
  private history: ConversationEntry[] = [];
  private projectContext: ProjectContext = {
    recentChanges: [],
    fileModifications: new Map(),
    commonPatterns: [],
    userPreferences: {
      preferredActions: [],
      rejectionReasons: [],
    },
  };

  addEntry(entry: Omit<ConversationEntry, "id" | "timestamp">): string {
    const id = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const fullEntry: ConversationEntry = {
      ...entry,
      id,
      timestamp: new Date(),
    };

    this.history.push(fullEntry);
    this.updateProjectContext(fullEntry);

    // Keep only last 50 entries
    if (this.history.length > 50) {
      this.history = this.history.slice(-50);
    }

    return id;
  }

  getRecentContext(limit: number = 5): ConversationEntry[] {
    return this.history.slice(-limit);
  }

  getRelatedChanges(file: string): ConversationEntry[] {
    return this.history.filter(
      (entry) =>
        entry.proposal?.file === file || entry.finalChange?.file === file
    );
  }

  getUserPatterns(): string[] {
    // Analyze user behavior patterns
    const patterns = [];

    // Common rejection reasons
    const rejections = this.history
      .filter((e) => e.outcome === "rejected")
      .map((e) => e.context)
      .filter(Boolean);

    if (rejections.length > 0) {
      patterns.push(
        `User often rejects changes because: ${rejections.slice(-3).join(", ")}`
      );
    }

    // Preferred file types
    const fileTypes = this.history
      .filter((e) => e.outcome === "accepted")
      .map((e) => e.proposal?.file)
      .filter(Boolean)
      .map((f) => f.split(".").pop())
      .filter((ext): ext is string => Boolean(ext))
      .reduce((acc, ext) => {
        acc[ext] = (acc[ext] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    const topFileType = Object.entries(fileTypes).sort(
      ([, a], [, b]) => (b as number) - (a as number)
    )[0];

    if (topFileType) {
      patterns.push(`User frequently works with .${topFileType[0]} files`);
    }

    return patterns;
  }

  private updateProjectContext(entry: ConversationEntry): void {
    this.projectContext.recentChanges.push(entry);

    if (entry.proposal?.file) {
      const file = entry.proposal.file;
      const current = this.projectContext.fileModifications.get(file) || {
        count: 0,
        lastModified: new Date(),
      };
      this.projectContext.fileModifications.set(file, {
        count: current.count + 1,
        lastModified: new Date(),
      });
    }
  }

  getContextForPrompt(): string {
    const recent = this.getRecentContext(3);
    const patterns = this.getUserPatterns();

    let context = "";

    if (recent.length > 0) {
      context += "Recent conversation context:\n";
      recent.forEach((entry) => {
        context += `- ${entry.userInput} → ${entry.outcome}\n`;
      });
      context += "\n";
    }

    if (patterns.length > 0) {
      context += "User patterns:\n";
      patterns.forEach((pattern) => {
        context += `- ${pattern}\n`;
      });
      context += "\n";
    }

    return context;
  }
}

export const conversationHistory = new ConversationHistory();
export type { ConversationEntry };
