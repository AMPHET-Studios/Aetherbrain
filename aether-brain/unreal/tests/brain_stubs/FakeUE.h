// A stand-in for the slice of Unreal Engine 5.x that AetherBrainActor.cpp and AetherScene.cpp use (see ../brain_actor_harness.cpp). It is NOT Unreal: it is shaped
// after the real signatures (checked against the public UE 5.6/5.7 mirrors where noted) so that typos, wrong argument types,
// wrong overloads and -Wshadow clashes in the new code are found by an ordinary compiler, and so the new code paths can be RUN.
//
// Differences that matter and are modelled on purpose:
//   * FMath::Clamp/Max/Min take ONE type T for all arguments (UE 5.7 UnrealMathUtility.h), so mixed int32/int64/float calls fail here
//     exactly as they would in the engine.
//   * FVector::operator[], FMath::Clamp, FVector::Dist are [[nodiscard]] like the 5.7 headers.
//   * FString::Printf checks its format against its arguments (like UE_CHECK_FORMAT_STRING) via the compiler's printf checker.
//   * UInstancedStaticMeshComponent::BatchUpdateInstancesTransforms has both the TArray and the TArrayView overload (UE 5.7), and
//     rejects (returns false, changes nothing) a range that does not fit the instances, as the engine does.
#pragma once

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <initializer_list>
#include <limits>
#include <map>
#include <memory>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

using int8 = int8_t;
using int16 = int16_t;
using int32 = int32_t;
using int64 = int64_t;
using uint8 = uint8_t;
using uint16 = uint16_t;
using uint32 = uint32_t;
using uint64 = uint64_t;
using SIZE_T = size_t;
using TCHAR = char;

#define TEXT(x) x
#define UCLASS(...)
#define USTRUCT(...)
#define UENUM(...)
#define UPROPERTY(...)
#define UFUNCTION(...)
#define GENERATED_BODY() public: using Super = AActor;
#define AETHERBRAIN_API
#define INDEX_NONE (-1)
#define FORCEINLINE inline
#define UE_FORCEINLINE_HINT inline
#define UE_PI (3.1415926535897932f)
#define PLATFORM_WINDOWS 0
#define PLATFORM_MAC 0
#define THIRD_PARTY_INCLUDES_START
#define THIRD_PARTY_INCLUDES_END
#define UE_LOG(Category, Verbosity, Format, ...) ((void)0)

enum EForceInit { ForceInit, ForceInitToZero };

template <class T>
T&& MoveTemp(T& V) { return static_cast<T&&>(V); }
template <class T>
T&& MoveTemp(T&& V) { return static_cast<T&&>(V); }

/* ---- math -------------------------------------------------------------------------------------------------- */

struct FRotator;
struct FQuat;

struct FVector
{
	double X = 0.0;
	double Y = 0.0;
	double Z = 0.0;
	FVector() = default;
	FVector(double InX, double InY, double InZ) : X(InX), Y(InY), Z(InZ) {}
	explicit FVector(double V) : X(V), Y(V), Z(V) {}
	explicit FVector(EForceInit) : X(0), Y(0), Z(0) {}
	static const FVector ZeroVector;

	FVector operator+(const FVector& O) const { return FVector(X + O.X, Y + O.Y, Z + O.Z); }
	FVector operator-(const FVector& O) const { return FVector(X - O.X, Y - O.Y, Z - O.Z); }
	FVector operator*(double S) const { return FVector(X * S, Y * S, Z * S); }
	FVector operator/(double S) const { return FVector(X / S, Y / S, Z / S); }
	friend FVector operator*(double S, const FVector& V) { return V * S; }
	[[nodiscard]] double& operator[](int32 Index) { assert(Index >= 0 && Index < 3); return (&X)[Index]; }
	[[nodiscard]] double operator[](int32 Index) const { assert(Index >= 0 && Index < 3); return (&X)[Index]; }
	[[nodiscard]] double Size() const { return std::sqrt(X * X + Y * Y + Z * Z); }
	[[nodiscard]] double SizeSquared() const { return X * X + Y * Y + Z * Z; }
	[[nodiscard]] FVector GetSafeNormal() const { const double S = Size(); return S > 1e-8 ? *this / S : FVector(0.0, 0.0, 0.0); }
	[[nodiscard]] static double DotProduct(const FVector& A, const FVector& B) { return A.X * B.X + A.Y * B.Y + A.Z * B.Z; }
	[[nodiscard]] static double Dist(const FVector& A, const FVector& B) { return (A - B).Size(); }
	FRotator Rotation() const;
	FVector& operator+=(const FVector& O) { X += O.X; Y += O.Y; Z += O.Z; return *this; }
};
inline const FVector FVector::ZeroVector = FVector(0.0, 0.0, 0.0);

struct FRotator
{
	double Pitch = 0.0;
	double Yaw = 0.0;
	double Roll = 0.0;
};
inline FRotator FVector::Rotation() const { return FRotator{}; }

struct FQuat
{
	double X = 0.0;
	double Y = 0.0;
	double Z = 0.0;
	double W = 1.0;
	FQuat() = default;
	FQuat(double InX, double InY, double InZ, double InW) : X(InX), Y(InY), Z(InZ), W(InW) {}
	static const FQuat Identity;
	void Normalize()
	{
		const double S = std::sqrt(X * X + Y * Y + Z * Z + W * W);
		if (S > 1e-12) { X /= S; Y /= S; Z /= S; W /= S; } else { X = Y = Z = 0.0; W = 1.0; }
	}
	FVector RotateVector(const FVector& V) const
	{
		const FVector Q(X, Y, Z);
		const FVector T = FVector(Q.Y * V.Z - Q.Z * V.Y, Q.Z * V.X - Q.X * V.Z, Q.X * V.Y - Q.Y * V.X) * 2.0;
		const FVector C(T.Y * Q.Z - T.Z * Q.Y, T.Z * Q.X - T.X * Q.Z, T.X * Q.Y - T.Y * Q.X);
		return V + T * W + C;
	}
};
inline const FQuat FQuat::Identity = FQuat(0.0, 0.0, 0.0, 1.0);

struct FTransform
{
	FQuat Rotation;
	FVector Translation;
	FVector Scale3D{1.0, 1.0, 1.0};
	FTransform() = default;
	FTransform(const FQuat& R, const FVector& T, const FVector& S = FVector(1.0, 1.0, 1.0)) : Rotation(R), Translation(T), Scale3D(S) {}
};

struct FColor
{
	uint8 R = 0, G = 0, B = 0, A = 255;
	template <class Str>
	static FColor FromHex(const Str& HexStr)
	{
		FColor C;
		unsigned V = 0;
		const std::string Hex = HexStr.S;
		std::sscanf(Hex.c_str() + (Hex[0] == '#' ? 1 : 0), "%x", &V);
		C.R = static_cast<uint8>((V >> 16) & 0xff);
		C.G = static_cast<uint8>((V >> 8) & 0xff);
		C.B = static_cast<uint8>(V & 0xff);
		return C;
	}
};

struct FLinearColor
{
	float R = 0.f, G = 0.f, B = 0.f, A = 1.f;
	FLinearColor() = default;
	FLinearColor(float InR, float InG, float InB, float InA = 1.f) : R(InR), G(InG), B(InB), A(InA) {}
	static const FLinearColor White;
	static FLinearColor FromSRGBColor(const FColor& C) { return FLinearColor(C.R / 255.f, C.G / 255.f, C.B / 255.f, 1.f); }
	FColor ToFColor(bool) const
	{
		FColor C;
		C.R = static_cast<uint8>(R * 255.f);
		C.G = static_cast<uint8>(G * 255.f);
		C.B = static_cast<uint8>(B * 255.f);
		return C;
	}
	FLinearColor operator+(const FLinearColor& O) const { return FLinearColor(R + O.R, G + O.G, B + O.B, A + O.A); }
	FLinearColor operator-(const FLinearColor& O) const { return FLinearColor(R - O.R, G - O.G, B - O.B, A - O.A); }
	FLinearColor operator*(float S) const { return FLinearColor(R * S, G * S, B * S, A * S); }
	friend FLinearColor operator*(float S, const FLinearColor& C) { return C * S; }
};
inline const FLinearColor FLinearColor::White = FLinearColor(1.f, 1.f, 1.f, 1.f);

struct FBox
{
	FVector Min, Max;
	bool bValid = false;
	explicit FBox(EForceInit) {}
	FBox& operator+=(const FVector& P)
	{
		if (!bValid) { Min = Max = P; bValid = true; }
		else { Min = FVector(std::min(Min.X, P.X), std::min(Min.Y, P.Y), std::min(Min.Z, P.Z)); Max = FVector(std::max(Max.X, P.X), std::max(Max.Y, P.Y), std::max(Max.Z, P.Z)); }
		return *this;
	}
	FVector GetCenter() const { return (Min + Max) * 0.5; }
	FVector GetExtent() const { return (Max - Min) * 0.5; }
};

template <class T>
struct TNumericLimits
{
	static constexpr T Max() { return std::numeric_limits<T>::max(); }
};

struct FMath
{
	// UE 5.7: one T for all three arguments.
	template <class T>
	[[nodiscard]] static constexpr T Clamp(const T X, const T MinValue, const T MaxValue) { return Max(Min(X, MaxValue), MinValue); }
	template <class T>
	[[nodiscard]] static constexpr T Max(const T A, const T B) { return A >= B ? A : B; }
	template <class T>
	[[nodiscard]] static constexpr T Min(const T A, const T B) { return A <= B ? A : B; }
	[[nodiscard]] static float Exp(float V) { return std::exp(V); }
	[[nodiscard]] static float Cos(float V) { return std::cos(V); }
	[[nodiscard]] static float Sin(float V) { return std::sin(V); }
	template <class T, class U>
	[[nodiscard]] static T Lerp(const T& A, const T& B, const U& Alpha) { return static_cast<T>(A + Alpha * (B - A)); }
};

struct FMemory
{
	static void* Memcpy(void* Dest, const void* Src, SIZE_T Count) { return std::memcpy(Dest, Src, Count); }
};

struct FRandomStream
{
	uint32 State;
	explicit FRandomStream(int32 Seed) : State(static_cast<uint32>(Seed)) {}
	float FRand() { State = State * 1664525u + 1013904223u; return static_cast<float>(State >> 8) / 16777216.f; }
	float FRandRange(float A, float B) { return A + (B - A) * FRand(); }
	FVector GetUnitVector() { return FVector(FRand() - 0.5, FRand() - 0.5, FRand() - 0.5).GetSafeNormal(); }
};

struct FRotationMatrix
{
	FQuat Q;
	static FRotationMatrix MakeFromZ(const FVector& Z)
	{
		FRotationMatrix M;
		const FVector N = Z.GetSafeNormal();
		const double Dot = N.Z;
		M.Q = FQuat(-N.Y, N.X, 0.0, 1.0 + Dot);
		M.Q.Normalize();
		return M;
	}
	FQuat ToQuat() const { return Q; }
};

/* ---- strings ----------------------------------------------------------------------------------------------- */

struct FString
{
	std::string S;
	FString() = default;
	FString(const char* In) : S(In ? In : "") {}
	explicit FString(const std::string& In) : S(In) {}
	bool IsEmpty() const { return S.empty(); }
	int32 Len() const { return static_cast<int32>(S.size()); }
	const char* operator*() const { return S.c_str(); }
	void Reset() { S.clear(); }
	bool RemoveFromEnd(const char* End)
	{
		const std::string E(End);
		if (S.size() >= E.size() && S.compare(S.size() - E.size(), E.size(), E) == 0) { S.resize(S.size() - E.size()); return true; }
		return false;
	}
	bool operator==(const FString& O) const { return S == O.S; }
	bool operator==(const char* O) const { return S == O; }
	friend FString operator+(const FString& A, const FString& B) { return FString(A.S + B.S); }
	friend FString operator/(const FString& A, const FString& B) { return FString(A.S + "/" + B.S); }
	[[gnu::format(printf, 1, 2)]] static FString Printf(const char* Fmt, ...)
	{
		char Buf[2048];
		va_list Args;
		va_start(Args, Fmt);
		std::vsnprintf(Buf, sizeof(Buf), Fmt, Args);
		va_end(Args);
		return FString(std::string(Buf));
	}
	// Needed as a TMap key.
	friend bool operator<(const FString& A, const FString& B) { return A.S < B.S; }
};
inline bool operator==(const char* A, const FString& B) { return B.S == A; }
struct FStringHash { size_t operator()(const FString& K) const { return std::hash<std::string>()(K.S); } };

struct FText
{
	std::string S;
	static FText FromString(const FString& In) { FText T; T.S = In.S; return T; }
};

struct FName
{
	std::string S;
	FName(const char* In) : S(In) {}
};

/* ---- containers and pointers -------------------------------------------------------------------------------- */

template <class T>
struct TArrayView
{
	const T* P = nullptr;
	int32 N = 0;
	TArrayView() = default;
	TArrayView(const T* InP, int32 InN) : P(InP), N(InN) {}
	int32 Num() const { return N; }
	const T& operator[](int32 I) const { return P[I]; }
};

template <class T>
struct TArray
{
	using SizeType = int32;
	using ElementType = T;
	std::vector<T> V;
	TArray() = default;
	TArray(std::initializer_list<T> L) : V(L) {}
	[[nodiscard]] int32 Num() const { return static_cast<int32>(V.size()); }
	[[nodiscard]] T* GetData() { return V.data(); }
	[[nodiscard]] const T* GetData() const { return V.data(); }
	[[nodiscard]] bool IsValidIndex(int32 I) const { return I >= 0 && I < Num(); }
	[[nodiscard]] bool IsEmpty() const { return V.empty(); }
	int32 Add(const T& X) { V.push_back(X); return Num() - 1; }
	int32 Add(T&& X) { V.push_back(std::move(X)); return Num() - 1; }
	void Reserve(int32 N) { V.reserve(static_cast<size_t>(N)); }
	void SetNum(int32 N) { V.resize(static_cast<size_t>(N)); }
	void SetNumZeroed(int32 N) { V.resize(static_cast<size_t>(N)); }
	void SetNumUninitialized(int32 N) { V.resize(static_cast<size_t>(N)); }
	void Empty(int32 Slack = 0) { V.clear(); V.reserve(static_cast<size_t>(Slack)); }
	// UE: Reset(SizeType NewSize = 0): keeps the allocation when NewSize fits.
	void Reset(int32 NewSize = 0)
	{
		if (NewSize < 0) NewSize = 0;
		if (static_cast<size_t>(NewSize) <= V.capacity()) { V.clear(); }
		else { V.clear(); V.reserve(static_cast<size_t>(NewSize)); }
	}
	[[nodiscard]] T& operator[](int32 I) { assert(I >= 0 && I < Num()); return V[static_cast<size_t>(I)]; }
	[[nodiscard]] const T& operator[](int32 I) const { assert(I >= 0 && I < Num()); return V[static_cast<size_t>(I)]; }
	template <class P>
	void Sort(P Pred) { std::sort(V.begin(), V.end(), [&Pred](const T& A, const T& B) { return Pred(A, B); }); }
	bool operator==(const TArray& O) const { return V == O.V; }
	operator TArrayView<T>() const { return TArrayView<T>(V.data(), Num()); }
	typename std::vector<T>::iterator begin() { return V.begin(); }
	typename std::vector<T>::iterator end() { return V.end(); }
	typename std::vector<T>::const_iterator begin() const { return V.begin(); }
	typename std::vector<T>::const_iterator end() const { return V.end(); }
};
// TArrayView<const T> spelled the UE way.
template <class T>
struct TArrayView<const T> : TArrayView<T> { using TArrayView<T>::TArrayView; TArrayView(const TArray<T>& A) : TArrayView<T>(A.GetData(), A.Num()) {} };

template <class K, class V>
struct TMap
{
	std::unordered_map<FString, V, FStringHash> M;
	void Reserve(int32 N) { M.reserve(static_cast<size_t>(N)); }
	V& Add(const K& Key, const V& Val) { return M[Key] = Val; }
	const V* Find(const K& Key) const { auto It = M.find(Key); return It == M.end() ? nullptr : &It->second; }
};

enum class ESPMode { ThreadSafe, NotThreadSafe };
template <class T, ESPMode M = ESPMode::ThreadSafe>
struct TSharedPtr : std::shared_ptr<T>
{
	TSharedPtr() = default;
	TSharedPtr(std::nullptr_t) {}
	TSharedPtr(std::shared_ptr<T> P) : std::shared_ptr<T>(std::move(P)) {}
	[[nodiscard]] bool IsValid() const { return static_cast<bool>(*this); }
	void Reset() { this->reset(); }
};
template <class T, ESPMode M = ESPMode::ThreadSafe>
using TSharedRef = TSharedPtr<T, M>;
template <class T, class... A>
TSharedPtr<T> MakeShared(A&&... Args) { return TSharedPtr<T>(std::make_shared<T>(std::forward<A>(Args)...)); }

class UObject
{
public:
	virtual ~UObject() = default;
	template <class T>
	T* CreateDefaultSubobject(const TCHAR*) { auto* O = new T(); return O; }
};

template <class T>
struct TObjectPtr
{
	T* P = nullptr;
	TObjectPtr() = default;
	TObjectPtr(T* In) : P(In) {}
	TObjectPtr& operator=(T* In) { P = In; return *this; }
	T* Get() const { return P; }
	T* operator->() const { return P; }
	operator T*() const { return P; }
};

template <class T>
struct TWeakObjectPtr
{
	T* P = nullptr;
	T* Get() const { return P; }
};

struct FSoftObjectPath { explicit FSoftObjectPath(const TCHAR*) {} };
template <class T>
struct TSoftObjectPtr
{
	T* Loaded = nullptr;
	TSoftObjectPtr() = default;
	explicit TSoftObjectPtr(const FSoftObjectPath&) {}
	T* LoadSynchronous() const { return Loaded; }
};

/* ---- components and actors --------------------------------------------------------------------------------- */

enum class EComponentMobility { Static, Stationary, Movable };
enum class ECollisionEnabled { NoCollision };
enum EHorizTextAligment { EHTA_Center };
enum EVerticalTextAligment { EVRTA_TextBottom };
namespace EEndPlayReason { enum Type { Destroyed, EndPlayInEditor }; }

class UMaterialInterface : public UObject {};
class UStaticMesh : public UObject {};

namespace ConstructorHelpers
{
template <class T>
struct FObjectFinder
{
	T* Object = nullptr;
	explicit FObjectFinder(const TCHAR*) { Object = new T(); }
};
} // namespace ConstructorHelpers

class USceneComponent : public UObject
{
public:
	bool bRegistered = false;
	bool bVisible = true;
	void SetMobility(EComponentMobility) {}
	void SetupAttachment(USceneComponent*) {}
	void SetWorldLocationAndRotation(const FVector&, const FRotator&) {}
	void SetVisibility(bool V, bool = false) { bVisible = V; }
	void RegisterComponent() { bRegistered = true; }
};

class UPrimitiveComponent : public USceneComponent
{
public:
	UMaterialInterface* Material = nullptr;
	void SetCollisionEnabled(ECollisionEnabled) {}
	void SetCastShadow(bool) {}
	void SetGenerateOverlapEvents(bool) {}
	void SetMaterial(int32, UMaterialInterface* M) { Material = M; }
};

class UStaticMeshComponent : public UPrimitiveComponent
{
public:
	UStaticMesh* Mesh = nullptr;
	bool SetStaticMesh(UStaticMesh* M) { Mesh = M; return true; }
};

class UTextRenderComponent : public UPrimitiveComponent
{
public:
	void SetHorizontalAlignment(EHorizTextAligment) {}
	void SetVerticalAlignment(EVerticalTextAligment) {}
	void SetText(const FText&) {}
	void SetTextRenderColor(FColor) {}
	void SetWorldSize(float S) { WorldSize = S; ++SizeCalls; }
	float WorldSize = 0.f;
	int SizeCalls = 0;
};

class UInstancedStaticMeshComponent : public UStaticMeshComponent
{
public:
	std::vector<FTransform> Instances;
	std::vector<float> CustomData;
	int32 NumCustom = 0;
	// What the harness looks at.
	int BatchCalls = 0;
	int BatchRejected = 0;
	int ClearCalls = 0;
	int AddCalls = 0;

	int32 AddInstance(const FTransform& T, bool = false)
	{
		++AddCalls;
		Instances.push_back(T);
		CustomData.resize(Instances.size() * static_cast<size_t>(NumCustom), 0.f);
		return static_cast<int32>(Instances.size()) - 1;
	}
	void ClearInstances() { ++ClearCalls; Instances.clear(); CustomData.clear(); }
	int32 GetInstanceCount() const { return static_cast<int32>(Instances.size()); }
	bool SetCustomDataValue(int32 I, int32 D, float V, bool = false)
	{
		if (I < 0 || static_cast<size_t>(I) >= Instances.size() || D < 0 || D >= NumCustom) return false;
		CustomData[static_cast<size_t>(I) * static_cast<size_t>(NumCustom) + static_cast<size_t>(D)] = V;
		return true;
	}
	void SetNumCustomDataFloats(int32 N) { NumCustom = N; CustomData.resize(Instances.size() * static_cast<size_t>(N), 0.f); }
	void MarkRenderStateDirty() {}
	// UE 5.7 has BOTH of these (InstancedStaticMeshComponent.h).
	virtual bool BatchUpdateInstancesTransforms(int32 StartInstanceIndex, const TArray<FTransform>& NewInstancesTransforms, bool bWorldSpace = false, bool bMarkRenderStateDirty = false, bool bTeleport = false)
	{
		return BatchUpdateInstancesTransforms(StartInstanceIndex, TArrayView<const FTransform>(NewInstancesTransforms), bWorldSpace, bMarkRenderStateDirty, bTeleport);
	}
	virtual bool BatchUpdateInstancesTransforms(int32 StartInstanceIndex, TArrayView<const FTransform> NewInstancesTransforms, bool = false, bool = false, bool = false)
	{
		++BatchCalls;
		// The engine: both ends of the range must be valid instance indices; otherwise false and nothing changes.
		const int32 Count = GetInstanceCount();
		if (StartInstanceIndex < 0 || StartInstanceIndex >= Count || NewInstancesTransforms.Num() < 1 || StartInstanceIndex + NewInstancesTransforms.Num() - 1 >= Count)
		{
			++BatchRejected;
			return false;
		}
		for (int32 I = 0; I < NewInstancesTransforms.Num(); ++I) Instances[static_cast<size_t>(StartInstanceIndex + I)] = NewInstancesTransforms[I];
		return true;
	}
};

// A representative slice of AActor's own data members, so a local with the same name in the new code is caught by -Wshadow as it
// would be in the engine. (The real class has many more; these are the ones with names a rendering/network actor might clash with.)
struct FActorTickFunction { bool bCanEverTick = false; bool bStartWithTickEnabled = false; };
class UWorld;
class AActor : public UObject
{
public:
	FActorTickFunction PrimaryActorTick;
	USceneComponent* RootComponent = nullptr;
	float CustomTimeDilation = 1.f;
	float InitialLifeSpan = 0.f;
	std::vector<FName> Tags;
	std::vector<FName> Layers;
	AActor* Instigator = nullptr;
	AActor* ParentComponentActor = nullptr;
	std::vector<AActor*> Children;
	float NetUpdateFrequency = 100.f;
	float NetPriority = 1.f;
	bool bHidden = false;
	bool bReplicates = false;
	bool bCanBeDamaged = true;
	int32 InputPriority = 0;
	UWorld* WorldPtr = nullptr;
	void SetRootComponent(USceneComponent* R) { RootComponent = R; }
	UWorld* GetWorld() const { return WorldPtr; }
	virtual void BeginPlay() {}
	virtual void EndPlay(const EEndPlayReason::Type) {}
	virtual void Tick(float) {}
private:
	AActor* Owner = nullptr;
};

class APlayerCameraManager : public UObject
{
public:
	FVector Location;
	FVector GetCameraLocation() const { return Location; }
};

class APlayerController : public AActor
{
public:
	TObjectPtr<APlayerCameraManager> PlayerCameraManager;
};

class UWorld
{
public:
	APlayerController* Player = nullptr;
	APlayerController* GetFirstPlayerController() const { return Player; }
};

/* ---- time ---------------------------------------------------------------------------------------------------- */

struct FPlatformTime
{
	static double& Fake() { static double T = 100.0; return T; }
	static double Seconds() { return Fake(); }
};

/* ---- http ---------------------------------------------------------------------------------------------------- */

struct FHttpResponseFake
{
	int32 Code = 200;
	std::string Body;
	std::vector<uint8> Bytes;
	std::map<std::string, std::string> Headers;
	int32 GetResponseCode() const { return Code; }
	FString GetContentAsString() const { return FString(Body); }
	const TArray<uint8>& GetContent() const { static TArray<uint8> A; A.V = Bytes; return A; }
	FString GetHeader(const FString& K) const { auto It = Headers.find(K.S); return It == Headers.end() ? FString() : FString(It->second); }
};
using IHttpResponse = FHttpResponseFake;
using FHttpResponsePtr = TSharedPtr<FHttpResponseFake>;

class IHttpRequest;
using FHttpRequestPtr = TSharedPtr<IHttpRequest>;
struct FCompleteDelegate
{
	void Unbind() {}
	template <class O, class F>
	void BindUObject(O*, F) {}
};
class IHttpRequest
{
public:
	void SetURL(const FString&) {}
	void SetVerb(const FString&) {}
	void SetHeader(const FString&, const FString&) {}
	void SetTimeout(float) {}
	void SetContentAsString(const FString&) {}
	FCompleteDelegate& OnProcessRequestComplete() { return Delegate; }
	bool ProcessRequest() { return true; }
	void CancelRequest() {}
	FCompleteDelegate Delegate;
};
struct FHttpModule
{
	static FHttpModule& Get() { static FHttpModule M; return M; }
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> CreateRequest() { return TSharedRef<IHttpRequest, ESPMode::ThreadSafe>(std::make_shared<IHttpRequest>()); }
};

/* ---- json ---------------------------------------------------------------------------------------------------- */

struct FJsonObject;
struct FJsonValue
{
	enum class Kind { Null, Bool, Number, String, Array, Object } K = Kind::Null;
	bool B = false;
	double N = 0.0;
	std::string Str;
	TArray<TSharedPtr<FJsonValue>> Arr;
	TSharedPtr<FJsonObject> Obj;
	bool TryGetNumber(double& Out) const
	{
		if (K == Kind::Number) { Out = N; return true; }
		if (K == Kind::String) { char* End = nullptr; const double V = std::strtod(Str.c_str(), &End); if (End != Str.c_str() && *End == 0) { Out = V; return true; } }
		return false;
	}
	bool TryGetObject(const TSharedPtr<FJsonObject>*& Out) const
	{
		if (K == Kind::Object) { Out = &Obj; return true; }
		return false;
	}
};
struct FJsonObject
{
	std::map<std::string, TSharedPtr<FJsonValue>> Fields;
	bool TryGetStringField(const FString& Name, FString& Out) const
	{
		auto It = Fields.find(Name.S);
		if (It == Fields.end() || It->second->K != FJsonValue::Kind::String) return false;
		Out = FString(It->second->Str);
		return true;
	}
	bool TryGetNumberField(const FString& Name, double& Out) const
	{
		auto It = Fields.find(Name.S);
		return It != Fields.end() && It->second->TryGetNumber(Out);
	}
	bool TryGetArrayField(const FString& Name, const TArray<TSharedPtr<FJsonValue>>*& Out) const
	{
		auto It = Fields.find(Name.S);
		if (It == Fields.end() || It->second->K != FJsonValue::Kind::Array) return false;
		Out = &It->second->Arr;
		return true;
	}
	bool TryGetObjectField(const FString& Name, const TSharedPtr<FJsonObject>*& Out) const
	{
		auto It = Fields.find(Name.S);
		if (It == Fields.end() || It->second->K != FJsonValue::Kind::Object) return false;
		Out = &It->second->Obj;
		return true;
	}
	void SetStringField(const FString& Name, const FString& V) { auto J = MakeShared<FJsonValue>(); J->K = FJsonValue::Kind::String; J->Str = V.S; Fields[Name.S] = J; }
	void SetBoolField(const FString& Name, bool V) { auto J = MakeShared<FJsonValue>(); J->K = FJsonValue::Kind::Bool; J->B = V; Fields[Name.S] = J; }
};

// A small JSON parser, enough for the app's /v1/graph.
struct FJsonParser
{
	const std::string& S;
	size_t I = 0;
	explicit FJsonParser(const std::string& In) : S(In) {}
	void Ws() { while (I < S.size() && std::isspace(static_cast<unsigned char>(S[I]))) ++I; }
	TSharedPtr<FJsonValue> Value()
	{
		Ws();
		if (I >= S.size()) return nullptr;
		auto V = MakeShared<FJsonValue>();
		const char C = S[I];
		if (C == '{')
		{
			++I; V->K = FJsonValue::Kind::Object; V->Obj = MakeShared<FJsonObject>();
			Ws();
			if (S[I] == '}') { ++I; return V; }
			for (;;)
			{
				Ws();
				auto Key = Value();
				if (!Key || Key->K != FJsonValue::Kind::String) return nullptr;
				Ws();
				if (S[I++] != ':') return nullptr;
				auto Val = Value();
				if (!Val) return nullptr;
				V->Obj->Fields[Key->Str] = Val;
				Ws();
				if (S[I] == ',') { ++I; continue; }
				if (S[I] == '}') { ++I; return V; }
				return nullptr;
			}
		}
		if (C == '[')
		{
			++I; V->K = FJsonValue::Kind::Array;
			Ws();
			if (S[I] == ']') { ++I; return V; }
			for (;;)
			{
				auto E = Value();
				if (!E) return nullptr;
				V->Arr.Add(E);
				Ws();
				if (S[I] == ',') { ++I; continue; }
				if (S[I] == ']') { ++I; return V; }
				return nullptr;
			}
		}
		if (C == '"')
		{
			++I; V->K = FJsonValue::Kind::String;
			while (I < S.size() && S[I] != '"') { if (S[I] == '\\') ++I; V->Str.push_back(S[I++]); }
			++I;
			return V;
		}
		if (S.compare(I, 4, "true") == 0) { I += 4; V->K = FJsonValue::Kind::Bool; V->B = true; return V; }
		if (S.compare(I, 5, "false") == 0) { I += 5; V->K = FJsonValue::Kind::Bool; return V; }
		if (S.compare(I, 4, "null") == 0) { I += 4; return V; }
		char* End = nullptr;
		const double N = std::strtod(S.c_str() + I, &End);
		if (End == S.c_str() + I) return nullptr;
		I = static_cast<size_t>(End - S.c_str());
		V->K = FJsonValue::Kind::Number; V->N = N;
		return V;
	}
};
template <class C>
struct TJsonReader { std::string Text; };
template <class C>
struct TJsonReaderFactory
{
	static TSharedRef<TJsonReader<C>> Create(const FString& In) { auto R = MakeShared<TJsonReader<C>>(); R->Text = In.S; return R; }
};
struct FJsonSerializer
{
	static bool Deserialize(const TSharedPtr<TJsonReader<char>>& R, TSharedPtr<FJsonObject>& Out)
	{
		FJsonParser P(R->Text);
		auto V = P.Value();
		if (!V || V->K != FJsonValue::Kind::Object) return false;
		Out = V->Obj;
		return true;
	}
	template <class W>
	static bool Serialize(const TSharedPtr<FJsonObject>&, const W&) { return true; }
};
template <class C>
struct TJsonWriter { FString* Out = nullptr; };
template <class C>
struct TJsonWriterFactory { static TSharedRef<TJsonWriter<C>> Create(FString* O) { auto W = MakeShared<TJsonWriter<C>>(); W->Out = O; return W; } };

/* ---- misc ----------------------------------------------------------------------------------------------------- */

struct FPlatformMisc { static FString GetEnvironmentVariable(const char* N) { const char* V = std::getenv(N); return FString(V ? V : ""); } };
struct FPaths { static bool FileExists(const FString&) { return false; } };
struct FFileHelper { static bool LoadFileToString(FString&, const char*) { return false; } };
struct FCommandLine { static const char* Get() { return ""; } };
struct FParse { static bool Value(const char*, const char*, FString&) { return false; } };

template <class T>
T* NewObject(UObject*) { return new T(); }
