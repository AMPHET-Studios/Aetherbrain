// The brain, drawn live from the Aether Brain desktop app's companion link: every node a glowing sphere in the
// brain's own colour and size, links and orbit rings as thin glowing threads, labels on suns, stars and planets,
// a starfield behind. One instanced mesh per kind of thing (one draw call each), whatever the size of the vault.
#pragma once

#include "CoreMinimal.h"
#include "AetherScene.h"
#include "GameFramework/Actor.h"
#include "Interfaces/IHttpRequest.h"
#include "AetherBrainActor.generated.h"

class UInstancedStaticMeshComponent;
class UMaterialInterface;
class UStaticMesh;
class UTextRenderComponent;

UCLASS()
class AETHERBRAIN_API AAetherBrainActor : public AActor
{
	GENERATED_BODY()

public:
	AAetherBrainActor();

	/** Centimetres per brain unit. */
	UPROPERTY(EditAnywhere, Category = "Aether Brain", meta = (ClampMin = "1.0"))
	float WorldScale = 20.f;

	/** The companion link's address, e.g. http://127.0.0.1:7459. Empty: read companion.json (or -AetherUrl=). */
	UPROPERTY(EditAnywhere, Category = "Aether Brain|Connection")
	FString Url;

	/** The companion link's token. Empty: read companion.json (or -AetherToken=). */
	UPROPERTY(EditAnywhere, Category = "Aether Brain|Connection")
	FString Token;

	UPROPERTY(EditAnywhere, Category = "Aether Brain")
	bool bShowLinks = true;

	UPROPERTY(EditAnywhere, Category = "Aether Brain")
	bool bShowOrbits = true;

	/** At most this many links are drawn (the first ones the brain sends). */
	UPROPERTY(EditAnywhere, Category = "Aether Brain", meta = (ClampMin = "0"))
	int32 MaxLinks = 20000;

	/** Suns, stars and planets get a floating name, up to this many. */
	UPROPERTY(EditAnywhere, Category = "Aether Brain", meta = (ClampMin = "0"))
	int32 MaxLabels = 160;

	/** Multiplies every glow (bloom comes from values above 1). */
	UPROPERTY(EditAnywhere, Category = "Aether Brain", meta = (ClampMin = "0.0"))
	float GlowScale = 1.f;

	/** Fly to what is selected in the desktop app when it changes there. */
	UPROPERTY(EditAnywhere, Category = "Aether Brain")
	bool bFollowBrainSelection = true;

	/** Unlit, emissive, reads its colour (custom data 0-2) and glow (3) per instance. Made by Content/Python/init_unreal.py. */
	UPROPERTY(EditAnywhere, Category = "Aether Brain")
	TSoftObjectPtr<UMaterialInterface> NodeMaterial;

	/* ---- for the player controller and the HUD ---- */

	int32 NumNodes() const { return Graph.Nodes.Num(); }
	const FAetherNode* GetNode(int32 Index) const { return Graph.Nodes.IsValidIndex(Index) ? &Graph.Nodes[Index] : nullptr; }
	/** Where the node is drawn now (Unreal space). */
	FVector NodeLocation(int32 Index) const { return Current.IsValidIndex(Index) ? Current[Index] : FVector::ZeroVector; }
	/** Its drawn radius (cm). */
	float NodeRadius(int32 Index) const;
	/** The node under a ray (the nearest one hit, a little generous far away), or INDEX_NONE. */
	int32 Pick(const FVector& Origin, const FVector& Direction) const;
	/** A sphere around everything; false before the first positions. */
	bool GetBounds(FVector& Center, float& Radius) const;
	/** The next project star after From (Tab), or INDEX_NONE. */
	int32 NextStar(int32 From) const;

	int32 GetSelected() const { return Selected; }
	void SetHovered(int32 Index);
	/** Select a node here and in the desktop app (which flies to it); bOpen opens it there. */
	void SelectNode(int32 Index, bool bOpen);
	/** The desktop app selected something else since the last call. */
	bool ConsumeBrainSelection(int32& OutIndex);
	/** The first positions came in since the last call (frame the brain). */
	bool ConsumeFirstPositions();

	/** The plain stars the brain draws by itself (the space actor draws a richer sky and turns these off). */
	void SetBuiltInStars(bool bOn);

	const FString& GetStatus() const { return Status; }
	bool IsLive() const { return bLive; }
	const FString& GetVaultName() const { return Graph.Vault; }
	bool IsMaterialMissing() const { return bMaterialMissing; }

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaSeconds) override;

private:
	UPROPERTY(VisibleAnywhere, Category = "Aether Brain")
	TObjectPtr<USceneComponent> Root;

	UPROPERTY(VisibleAnywhere, Category = "Aether Brain")
	TObjectPtr<UInstancedStaticMeshComponent> Spheres;

	UPROPERTY(VisibleAnywhere, Category = "Aether Brain")
	TObjectPtr<UInstancedStaticMeshComponent> Links;

	UPROPERTY(VisibleAnywhere, Category = "Aether Brain")
	TObjectPtr<UInstancedStaticMeshComponent> Orbits;

	UPROPERTY(VisibleAnywhere, Category = "Aether Brain")
	TObjectPtr<UInstancedStaticMeshComponent> Starfield;

	UPROPERTY(Transient)
	TArray<TObjectPtr<UTextRenderComponent>> Labels;

	UPROPERTY()
	TObjectPtr<UStaticMesh> SphereMesh;

	UPROPERTY()
	TObjectPtr<UStaticMesh> CylinderMesh;

	UPROPERTY()
	TObjectPtr<UMaterialInterface> FallbackMaterial;

	/* ---- the link ---- */
	void Connect();
	void RequestGraph();
	void RequestPositions();
	void OnGraph(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bConnectedSuccessfully);
	void OnPositions(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bConnectedSuccessfully);
	/** False (and the status says why) for an answer that is not a usable 200 / 304. */
	bool CheckAnswer(FHttpResponsePtr Response, bool bConnectedSuccessfully);
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> NewRequest(const FString& Path, const FString& Verb) const;

	/* ---- the scene ---- */
	void ApplyGraph(FAetherGraph&& NewGraph);
	void ApplyPositions(FAetherPositions&& NewPositions);
	void BuildStarfield();
	/** Make every instance again (bKeepInstances: same nodes and links, only colours and glows change). */
	void RebuildInstances(bool bKeepInstances);
	void UpdateInstances(float DeltaSeconds);
	void UpdateLabels();
	void SetNodeLook(int32 Index);
	float GlowOf(int32 Index) const;
	FTransform Thread(const FVector& A, const FVector& B, float RadiusCm) const;
	FVector ToBrain(const FVector& U) const { return FVector(U.X, U.Z, U.Y) / static_cast<double>(WorldScale); }

	FAetherConnection Conn;
	bool bConnFromSettings = false;
	TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> GraphRequest;
	TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> PositionsRequest;
	FString GraphTag;
	FString PositionsTag;
	double NextConnect = 0.0;
	double NextGraph = 0.0;
	double NextPositions = 0.0;

	FAetherGraph Graph;
	bool bHasGraph = false;
	/** Unreal space: where the brain says each node is, and where it is drawn (eased toward the target). */
	TArray<FVector> Target;
	TArray<FVector> Current;
	TArray<FAetherRing> Rings;
	bool bHasPositions = false;
	bool bFirstPositions = false;
	int32 LinkCount = 0;
	int32 OrbitSegments = 0;
	/** Label slot -> node index. */
	TArray<int32> LabelNodes;

	int32 Selected = INDEX_NONE;
	int32 Hovered = INDEX_NONE;
	int32 BrainSelected = INDEX_NONE;
	bool bBrainSelectionChanged = false;

	FString Status;
	bool bLive = false;
	bool bMaterialMissing = false;
};
