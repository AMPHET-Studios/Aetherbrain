// The Niagara layer: light that runs along the brain's links, a corona that breathes around each sun and a halo on whatever
// is selected, a ripple when something is selected, drifting dust around the camera, and shooting stars across the sky.
//
// The actor makes no particles itself. It plays five Niagara systems (NS_AetherPulses, NS_AetherCorona, NS_AetherDust,
// NS_AetherShootingStars and NS_AetherRipple in /Game/AetherFX/) by setting their User parameters from the live brain, a few
// pooled components at a time, and what happens when is planned by Private/AetherFxMath.h (tested without Unreal). The systems
// are made in the Unreal Editor, once, from the recipes in docs/UNREAL-NIAGARA.md; a system that is not there is simply not
// played and the viewer looks as it did before.
// Press N in the viewer to switch the effects on and off.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "AetherFxActor.generated.h"

class AAetherBrainActor;
class UNiagaraComponent;
class UNiagaraSystem;
struct FAetherFxState;

UCLASS()
class AETHERBRAIN_API AAetherFxActor : public AActor
{
	GENERATED_BODY()

public:
	AAetherFxActor();

	/** The effects are playing (N switches them). */
	UPROPERTY(EditAnywhere, Category = "Aether FX")
	bool bOn = true;

	/** Multiplies how much happens: pulses, dust, shooting stars. 0 stops them. */
	UPROPERTY(EditAnywhere, Category = "Aether FX", meta = (ClampMin = "0.0", ClampMax = "3.0"))
	float Density = 1.f;

	/** Multiplies how bright everything is (the Niagara systems read it as User.Intensity). */
	UPROPERTY(EditAnywhere, Category = "Aether FX", meta = (ClampMin = "0.0", ClampMax = "8.0"))
	float Glow = 1.f;

	/** Seeds everything random: the same number, the same pulses. */
	UPROPERTY(EditAnywhere, Category = "Aether FX")
	int32 Seed = 2026;

	/** The share of the pulses that run on the selected node's own links (when something is selected). */
	UPROPERTY(EditAnywhere, Category = "Aether FX", meta = (ClampMin = "0.0", ClampMax = "1.0"))
	float SelectionShare = 0.65f;

	UPROPERTY(EditAnywhere, Category = "Aether FX|Layers")
	bool bPulses = true;

	UPROPERTY(EditAnywhere, Category = "Aether FX|Layers")
	bool bCoronas = true;

	UPROPERTY(EditAnywhere, Category = "Aether FX|Layers")
	bool bDust = true;

	UPROPERTY(EditAnywhere, Category = "Aether FX|Layers")
	bool bShootingStars = true;

	UPROPERTY(EditAnywhere, Category = "Aether FX|Layers")
	bool bRipples = true;

	/** Pulses of light along links. User: Start, End (Position), Color, Duration, Size, Intensity. */
	UPROPERTY(EditAnywhere, Category = "Aether FX|Systems")
	TSoftObjectPtr<UNiagaraSystem> PulseSystem;

	/** The breathing glow round a sun, and the halo on the selection. User: Radius, Color, Intensity. */
	UPROPERTY(EditAnywhere, Category = "Aether FX|Systems")
	TSoftObjectPtr<UNiagaraSystem> CoronaSystem;

	/** Dust drifting round the camera. User: Extent (Vector), SpawnRate, Color, Intensity. */
	UPROPERTY(EditAnywhere, Category = "Aether FX|Systems")
	TSoftObjectPtr<UNiagaraSystem> DustSystem;

	/** A shooting star. User: Start, End (Position), Color, Duration, Width, Intensity. */
	UPROPERTY(EditAnywhere, Category = "Aether FX|Systems")
	TSoftObjectPtr<UNiagaraSystem> MeteorSystem;

	/** A ring growing out of a node that was just selected. User: Radius, Color, Duration, Intensity. */
	UPROPERTY(EditAnywhere, Category = "Aether FX|Systems")
	TSoftObjectPtr<UNiagaraSystem> RippleSystem;

	/**
	 * User.Start and User.End are Niagara Position parameters (the Large World Coordinates type; docs/UNREAL-NIAGARA.md makes them so).
	 * Untick if the systems were made with Vector parameters instead. (User.Extent, a size, is always a Vector.)
	 */
	UPROPERTY(EditAnywhere, Category = "Aether FX|Systems")
	bool bPositionParameters = true;

	/* ---- for the player controller and the HUD ---- */

	bool IsOn() const { return bOn; }
	/** Effects on, off, on ... */
	void Toggle();
	/** How many Niagara systems the layer plays, and how many of them were found when play started. */
	static int32 NumSystems() { return 5; }
	int32 NumReady() const;
	/** The asset name of a system (0 to NumSystems - 1), e.g. NS_AetherPulses. */
	static const TCHAR* SystemName(int32 System);
	bool IsReady(int32 System) const;
	/** Effects playing right now (a pulse that has just ended is still counted while its trail fades). */
	int32 NumPlaying() const;
	/** Effects that found no free Niagara component and were skipped, since play started. */
	int32 NumDropped() const;

protected:
	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

private:
	UPROPERTY(VisibleAnywhere, Category = "Aether FX")
	TObjectPtr<USceneComponent> Root;

	/** Every Niagara component made while playing (so the garbage collector keeps them). */
	UPROPERTY(Transient)
	TArray<TObjectPtr<UNiagaraComponent>> Components;

	const TSoftObjectPtr<UNiagaraSystem>& SoftOf(int32 System) const;
	/** A free component of a system, placed at Where and held for Seconds; null when there is none (the effect is dropped). */
	UNiagaraComponent* Take(int32 System, double Now, double Seconds, const FVector& Where);
	void ApplyOn();
	void RefreshShape(const AAetherBrainActor& B);
	void UpdateDust(double Dt, const FVector& Camera, double Field);
	void UpdateCoronas(double Now, const AAetherBrainActor& B);
	void FireRipples(double Now, const AAetherBrainActor& B);
	void RippleAt(double Now, const AAetherBrainActor& B, int32 Node);
	void FirePulses(double Prev, double Now, const AAetherBrainActor& B);
	void FireMeteors(double Prev, double Now, const FVector& Camera, const FVector& Forward);

	TSharedPtr<FAetherFxState> State;
	TWeakObjectPtr<AAetherBrainActor> Brain;
};
