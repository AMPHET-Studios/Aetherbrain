// The Voyage: a photographic sky and suns, real-looking ships, and a flight to a folder through asteroids you can blow up.
//
//  - An 8K nebula sky and an 8K sun for every drive (made in code on background threads when play starts, never stored in the
//    project), with a corona and limb darkening; the space actor's flat backdrop steps aside once the sky is ready.
//  - Three ships built in code (lofted hulls, wings, nozzles, greebles) with painted, scratched, riveted metal maps; a few drift
//    past the brain as traffic.
//  - Folders show an extra-large picture of what is in them (a card, fetched from the desktop app's companion link as a PNG).
//  - V flies the player's interceptor to the selected folder along a curved route through asteroid fields: the cannon fires where
//    the cursor points (left mouse), rocks break into smaller rocks and dust, a shield takes the hits. Arrive in front of the folder,
//    press Enter to open it in Aether Brain.
//
// All the maths (route, fields, shots, pieces, pilot, aim, meshes, maps) is plain C++ in Private/ and tested without Unreal
// (unreal/tests/run.sh); this file only draws it and feeds it input.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Interfaces/IHttpRequest.h"
#include "AetherVoyageActor.generated.h"

class AAetherBrainActor;
class AAetherSpaceActor;
class UInstancedStaticMeshComponent;
class UMaterialInstanceDynamic;
class UMaterialInterface;
class UProceduralMeshComponent;
class UStaticMesh;
class UStaticMeshComponent;
class UTexture2D;
struct FAetherVoyageState;

/** What the player is doing this frame. */
struct FAetherVoyageInput
{
	/** Steer sideways and up, each in [-1, 1]. */
	float Right = 0.f;
	float Up = 0.f;
	/** 0..1 of cruise speed. */
	float Throttle = 1.f;
	bool bFire = false;
	/** The cursor's ray into the world. */
	bool bHasAim = false;
	FVector AimDirection = FVector(1.0, 0.0, 0.0);
};

UCLASS()
class AETHERBRAIN_API AAetherVoyageActor : public AActor
{
	GENERATED_BODY()

public:
	AAetherVoyageActor();

	/* ---- the photographic sky and suns ---- */

	/** Draw the 8K nebula sky (and hide the space actor's flat backdrop once it is ready). */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage")
	bool bPhotoSky = true;

	/** Width of the sky picture in pixels (its height is half): 8192 = 8K, 4096 = 4K, 2048 = 2K for a weak graphics card. 128 MB of video memory at 8K. */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage", meta = (ClampMin = "512", ClampMax = "16384"))
	int32 SkyWidth = 8192;

	/** Width of a sun's surface picture in pixels (8192 = 8K); up to three kinds are made (red, yellow, blue), each 128 MB at 8K. */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage", meta = (ClampMin = "512", ClampMax = "16384"))
	int32 SunWidth = 8192;

	/** Brightness of the sky. */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage", meta = (ClampMin = "0.0", ClampMax = "4.0"))
	float SkyGlow = 1.f;

	/** Brightness of the suns' surfaces and coronas (bloom comes from values above 1). */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage", meta = (ClampMin = "0.0", ClampMax = "20.0"))
	float SunGlow = 6.f;

	/* ---- ships and rocks ---- */

	/** Width of the metal maps of the ships and of the rock maps, pixels (2048 is good; 4096 for a big screen). */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage", meta = (ClampMin = "256", ClampMax = "8192"))
	int32 MapSize = 2048;

	/** How long the player's interceptor is, cm. */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage", meta = (ClampMin = "100.0"))
	float ShipLengthCm = 520.f;

	/** Ships (a freighter, a research cruiser, interceptors) that drift past the brain. */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage", meta = (ClampMin = "0", ClampMax = "12"))
	int32 TrafficShips = 4;

	/** How many asteroid groups the flight to a folder holds (1 = as designed). */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage", meta = (ClampMin = "0.0", ClampMax = "3.0"))
	float AsteroidDensity = 1.f;

	/** The ship's own speed along the route, cm/s. */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage", meta = (ClampMin = "200.0"))
	float CruiseSpeed = 3200.f;

	/** Seeds everything random. */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage")
	int32 Seed = 2026;

	/* ---- folder pictures ---- */

	/** Folders show a big picture card (needs the desktop app's companion link). */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage|Cards")
	bool bFolderCards = true;

	/** How wide the card of a folder is, cm, at least (bigger folders get bigger cards). */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage|Cards", meta = (ClampMin = "100.0"))
	float CardWidthCm = 900.f;

	/** Pixels on the longer side of a card's picture (the app makes at most 1024). */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage|Cards", meta = (ClampMin = "64", ClampMax = "1024"))
	int32 CardPixels = 1024;

	/** At most this many cards are held (nearest folders first): 24 at 1024 px is about 130 MB. */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage|Cards", meta = (ClampMin = "1", ClampMax = "200"))
	int32 MaxCards = 24;

	/** Folders farther than this from the camera get no card, cm. */
	UPROPERTY(EditAnywhere, Category = "Aether Voyage|Cards", meta = (ClampMin = "500.0"))
	float CardRange = 60000.f;

	/* ---- materials (made by Content/Python/init_unreal.py) ---- */

	UPROPERTY(EditAnywhere, Category = "Aether Voyage|Materials")
	TSoftObjectPtr<UMaterialInterface> SkyMaterial;
	UPROPERTY(EditAnywhere, Category = "Aether Voyage|Materials")
	TSoftObjectPtr<UMaterialInterface> SunMaterial;
	UPROPERTY(EditAnywhere, Category = "Aether Voyage|Materials")
	TSoftObjectPtr<UMaterialInterface> CoronaMaterial;
	UPROPERTY(EditAnywhere, Category = "Aether Voyage|Materials")
	TSoftObjectPtr<UMaterialInterface> HullMaterial;
	UPROPERTY(EditAnywhere, Category = "Aether Voyage|Materials")
	TSoftObjectPtr<UMaterialInterface> GlassMaterial;
	UPROPERTY(EditAnywhere, Category = "Aether Voyage|Materials")
	TSoftObjectPtr<UMaterialInterface> LightMaterial;
	UPROPERTY(EditAnywhere, Category = "Aether Voyage|Materials")
	TSoftObjectPtr<UMaterialInterface> RockPbrMaterial;
	UPROPERTY(EditAnywhere, Category = "Aether Voyage|Materials")
	TSoftObjectPtr<UMaterialInterface> CardMaterial;

	/* ---- for the player controller and the HUD ---- */

	bool IsVoyaging() const;
	bool HasArrived() const;
	/** Start a voyage from `From` to a folder (a sun, project or folder node; a note flies to its folder). False if there is nowhere to go. */
	bool BeginVoyage(const FVector& From, int32 NodeIndex);
	/** Leave the voyage (the camera stays where it is). */
	void EndVoyage();
	/** Move the voyage on (the controller calls this each frame it is flying). */
	void StepVoyage(float DeltaSeconds, const FAetherVoyageInput& Input);
	/** The chase camera, while voyaging. */
	bool GetCamera(FVector& OutLocation, FRotator& OutRotation, float& OutFovDegrees) const;
	/** The node the voyage flies to, or INDEX_NONE. */
	int32 GetVoyageNode() const;
	/** The card (a folder) under a ray, or INDEX_NONE: cards are bigger than the folders' own spheres, so they are picked first. */
	int32 PickCard(const FVector& Origin, const FVector& Direction) const;

	float GetDistanceToGoMeters() const;
	float GetProgress() const;
	float GetShieldFraction() const;
	float GetHullFraction() const;
	int32 GetRocksBroken() const;
	int32 GetScore() const;
	/** A point far ahead along the guns (for the crosshair); false when not voyaging. */
	bool GetAimPoint(FVector& OutPoint) const;
	/** The rock the sights are on: where it is and how big (cm). */
	bool GetTargetRock(FVector& OutLocation, float& OutRadiusCm) const;

	/** What is being made or missing, for the HUD: empty when all is well. */
	FString GetStatus() const;
	int32 NumCardsShown() const;
	int32 NumCardsWithPictures() const;
	bool IsSkyReady() const { return bSkyReady; }

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaSeconds) override;

private:
	UPROPERTY(VisibleAnywhere, Category = "Aether Voyage")
	TObjectPtr<USceneComponent> Root;

	UPROPERTY()
	TObjectPtr<UStaticMesh> SphereMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> CylinderMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> CubeMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> PlaneMesh;
	UPROPERTY()
	TObjectPtr<UMaterialInterface> FallbackMaterial;

	/** Everything made while playing (so the garbage collector keeps it). */
	UPROPERTY(Transient)
	TArray<TObjectPtr<UObject>> Held;

	void FindBrainAndSpace();
	void PollBakes();
	void UpdateSky(const FVector& Camera);
	void UpdateSuns(const FVector& Camera);
	void UpdateTraffic(double Time);
	void UpdateVoyageVisuals(double Time);
	void UpdateCards(const FVector& Camera, double Time);
	void OnCardPicture(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bConnectedSuccessfully);
	void BuildShipVisuals();
	void BuildEffects();

	TSharedPtr<FAetherVoyageState> State;
	TWeakObjectPtr<AAetherBrainActor> Brain;
	TWeakObjectPtr<AAetherSpaceActor> Space;
	bool bSkyReady = false;
	/** The space actor has been told to hide its flat backdrop. */
	bool bBackdropHandled = false;
	bool bMaterialsMissing = false;
	double Clock = 0.0;
};
