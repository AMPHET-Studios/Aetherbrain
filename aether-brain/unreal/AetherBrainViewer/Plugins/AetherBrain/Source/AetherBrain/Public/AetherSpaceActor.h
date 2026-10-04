// The space the brain floats in: layers of stars, nebulae and far galaxies that slide against each other as the
// camera flies (parallax); asteroids going round the brain and zooming through it; shooting stars; and alien ships
// (saucers on patrol, squadrons of darts, huge mother ships sailing past, darting scouts).
//
// Nothing to import: the pictures are generated when play starts, the rocks and ships are built from the engine's basic
// shapes, and everything that moves is a pure function of time (Private/AetherSpaceMath.h, tested without Unreal).
// Press B in the viewer to cycle Full / Calm (backdrop only) / Off.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "AetherSpaceActor.generated.h"

class AAetherBrainActor;
class UDirectionalLightComponent;
class UInstancedStaticMeshComponent;
class UMaterialInstanceDynamic;
class UMaterialInterface;
class UStaticMesh;
class UTexture2D;
struct FAetherSpaceState;

/** How much of the space is shown. */
UENUM()
enum class EAetherSpaceMode : uint8
{
	/** Backdrop, asteroids, shooting stars, ships. */
	Full,
	/** The backdrop only: stars, nebulae, galaxies. */
	Calm,
	/** Black (the brain's own plain stars come back). */
	Off,
};

UCLASS()
class AETHERBRAIN_API AAetherSpaceActor : public AActor
{
	GENERATED_BODY()

public:
	AAetherSpaceActor();

	/** What is shown when play starts (B cycles it). */
	UPROPERTY(EditAnywhere, Category = "Aether Space")
	EAetherSpaceMode Mode = EAetherSpaceMode::Full;

	/** Multiplies how many stars, rocks and ships there are. */
	UPROPERTY(EditAnywhere, Category = "Aether Space", meta = (ClampMin = "0.0", ClampMax = "3.0"))
	float Density = 1.f;

	/** Rocks going round the brain in belts (before Density). */
	UPROPERTY(EditAnywhere, Category = "Aether Space", meta = (ClampMin = "0"))
	int32 AsteroidCount = 900;

	/** Bigger rocks zooming through, one pass after another (before Density). */
	UPROPERTY(EditAnywhere, Category = "Aether Space", meta = (ClampMin = "0"))
	int32 FlybyRockCount = 70;

	/** Streaks of light crossing the sky (before Density). */
	UPROPERTY(EditAnywhere, Category = "Aether Space", meta = (ClampMin = "0"))
	int32 ShootingStarCount = 40;

	/** How big the rocks are drawn (1 = as designed). */
	UPROPERTY(EditAnywhere, Category = "Aether Space", meta = (ClampMin = "0.1", ClampMax = "5.0"))
	float AsteroidScale = 1.f;

	/** How fast everything moves (1 = as designed, 0 stops time). */
	UPROPERTY(EditAnywhere, Category = "Aether Space", meta = (ClampMin = "0.0", ClampMax = "10.0"))
	float TimeScale = 1.f;

	/** Brightness of the backdrop (stars, nebulae, galaxies); 1 = as designed. */
	UPROPERTY(EditAnywhere, Category = "Aether Space", meta = (ClampMin = "0.0", ClampMax = "4.0"))
	float SkyGlow = 1.f;

	/** Width of the generated nebula and galaxy pictures, px (bigger is softer to look at and slower to start). */
	UPROPERTY(EditAnywhere, Category = "Aether Space", meta = (ClampMin = "64", ClampMax = "1024"))
	int32 TextureSize = 256;

	/** Seeds everything random: the same number, the same sky. */
	UPROPERTY(EditAnywhere, Category = "Aether Space")
	int32 Seed = 2026;

	/** The two lights (a warm key and a cool fill) that light the rocks and ships. */
	UPROPERTY(EditAnywhere, Category = "Aether Space")
	bool bStageLights = true;

	/** Unlit, additive, reads a picture (parameter Tex) and a tint and glow per instance. Made by Content/Python/init_unreal.py. */
	UPROPERTY(EditAnywhere, Category = "Aether Space")
	TSoftObjectPtr<UMaterialInterface> SpriteMaterial;

	/** Lit, reads a colour (custom data 0-2) and how metallic (3) per instance. Made by Content/Python/init_unreal.py. */
	UPROPERTY(EditAnywhere, Category = "Aether Space")
	TSoftObjectPtr<UMaterialInterface> RockMaterial;

	/* ---- for the player controller and the HUD ---- */

	EAetherSpaceMode GetMode() const { return Mode; }
	/** Full, Calm, Off, Full ... */
	void CycleMode();
	const TCHAR* GetModeName() const;
	/** The sprite material is not there: nebulae and galaxies cannot be drawn until init_unreal.py has run. */
	bool IsSpriteMaterialMissing() const { return bSpriteMaterialMissing; }

protected:
	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

private:
	UPROPERTY(VisibleAnywhere, Category = "Aether Space")
	TObjectPtr<USceneComponent> Root;

	UPROPERTY(VisibleAnywhere, Category = "Aether Space")
	TObjectPtr<UDirectionalLightComponent> KeyLight;

	UPROPERTY(VisibleAnywhere, Category = "Aether Space")
	TObjectPtr<UDirectionalLightComponent> FillLight;

	UPROPERTY()
	TObjectPtr<UStaticMesh> SphereMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> CylinderMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> ConeMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> CubeMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> PlaneMesh;
	UPROPERTY()
	TObjectPtr<UMaterialInterface> FallbackMaterial;

	/** Everything made while playing (so the garbage collector keeps it). */
	UPROPERTY(Transient)
	TArray<TObjectPtr<UTexture2D>> Textures;
	UPROPERTY(Transient)
	TArray<TObjectPtr<UMaterialInstanceDynamic>> SpriteMaterials;
	UPROPERTY(Transient)
	TArray<TObjectPtr<UInstancedStaticMeshComponent>> Components;

	void BuildBackdrop(UMaterialInterface* Sprites);
	void BuildMovers(UMaterialInterface* Glow, UMaterialInterface* Lit);
	void ApplyMode();
	void UpdateBackdrop(const FVector& Camera);
	void UpdateMovers(const FVector& Center);

	TSharedPtr<FAetherSpaceState> State;
	TWeakObjectPtr<AAetherBrainActor> Brain;
	/** Seconds of space time (real time x TimeScale): every path is a function of it. */
	double SpaceTime = 0.0;
	/** How far out the scene is laid out, eased toward the brain's size. */
	double FieldNow = 6000.0;
	bool bSpriteMaterialMissing = false;
};
